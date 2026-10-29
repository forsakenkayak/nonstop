import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { buildBuyIx } from './pump';

const TIP_LAMPORTS = 100_000;
const LOG_FILE = 'bundles.jsonl';
const WAIT_MS = 20_000;
const slippageTodo = 0.15;

type Row = { uuid: string; ts: number; landed: boolean | null };

const [mintArg, solArg] = process.argv.slice(2);
if (!mintArg || !solArg) {
  console.log('usage: bun run src/buy.ts <mint> <sol>');
  process.exit(1);
}

const mint = new PublicKey(mintArg);
const solIn = parseFloat(solArg);
const lamports = Math.floor(solIn * LAMPORTS_PER_SOL);
console.log(`buying ${solIn} sol worth of ${mint.toBase58()}`);
console.log('max cost', (solIn * (1 + slippageTodo)).toFixed(4), 'sol');

const conn = new Connection(Bun.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(await Bun.file(Bun.env.KEYPAIR_PATH ?? './keypair.json').json()),
);
const authKeypair = Keypair.fromSecretKey(
  Uint8Array.from(await Bun.file(Bun.env.AUTH_KEYPAIR!).json()),
);
console.log('payer', payer.publicKey.toBase58());

const buyIx = buildBuyIx({ mint, payer: payer.publicKey, lamports });

const alt = (await conn.getAddressLookupTable(new PublicKey(Bun.env.ALT!))).value;
if (!alt) {
  console.log('lookup table not found, check ALT env');
  process.exit(1);
}

const { blockhash } = await conn.getLatestBlockhash('confirmed');

const msg = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: blockhash,
  instructions: [buyIx],
}).compileToV0Message([alt]);

const buyTx = new VersionedTransaction(msg);
buyTx.sign([payer]);
console.log('buy transacton built, size', buyTx.serialize().length);

const c = searcherClient(Bun.env.BLOCK_ENGINE_URL!, authKeypair);

const tipRes = await c.getTipAccounts();
if (!tipRes.ok) {
  console.log('no tip accounts:', tipRes.error);
  process.exit(1);
}
const tipAccount = new PublicKey(tipRes.value[Math.floor(Math.random() * tipRes.value.length)]);
console.log('tip account', tipAccount.toBase58());

const bundle = new Bundle([buyTx], 2);
const withTip = bundle.addTipTx(payer, TIP_LAMPORTS, tipAccount, blockhash);
if (withTip instanceof Error) {
  console.log('addTipTx failed', withTip.message);
  process.exit(1);
}

const sent = await c.sendBundle(withTip);
if (!sent.ok) {
  console.log('bundle rejected:', sent.error);
  process.exit(1);
}
const uuid = sent.value;
console.log('bundle sent, id', uuid);

const past: Row[] = (await Bun.file(LOG_FILE).exists())
  ? (await Bun.file(LOG_FILE).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const mine: Row = { uuid, ts: Date.now(), landed: null };
const rows = [...past, mine];
const save = () => Bun.write(LOG_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
await save();

const stream = c.onBundleResult(
  async (res) => {
    if (res.bundleId !== uuid) return;
    console.log('bundle result', res.processed ? 'processed' : res.finalized ? 'finalized' : res.rejected ? 'rejected' : res.dropped ? 'dropped' : 'other');
    if (res.processed || res.finalized) mine.landed = true;
    else if (res.rejected || res.dropped) mine.landed = false;
    await save();
  },
  (err) => console.log('result stream err', err.message),
);

await new Promise((r) => setTimeout(r, WAIT_MS));
stream();
if (mine.landed === null) mine.landed = false;
await save();

const landedCount = rows.filter((r) => r.landed === true).length;
console.log(mine.landed ? 'landed' : 'failed', uuid);
console.log(
  `land rate ${landedCount}/${rows.length} = ${((landedCount / rows.length) * 100).toFixed(1)}%`,
);
