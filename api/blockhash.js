import { route, send, getLatestBlockhash } from './_lib.js';

export default route(async (req, res) => {
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash();
  send(res, 200, { blockhash, lastValidBlockHeight }, 0);
});
