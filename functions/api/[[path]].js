// Runs the game's server on the game's own site: every request to
// https://case-sim.pages.dev/api/... is handled here, by the same code as
// server/src/worker.js. So the game never has to talk to another website.
import server from '../../server/src/worker.js';

export const onRequest = (context) => server.fetch(context.request, context.env);
