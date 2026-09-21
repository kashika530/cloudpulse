// flaky-server.js : a fake website YOU control, for testing (never poke other people's sites).
//   npm run flaky      then monitor http://localhost:4000/ (set ALLOW_LOCAL_URLS=true in .env)
//   http://localhost:4000/__down  -> site starts failing (HTTP 500)
//   http://localhost:4000/__up    -> site is healthy again
let mode = "up";
require("http").createServer((req, res) => {
  if (req.url === "/__down") { mode = "down"; return res.end("now DOWN\n"); }
  if (req.url === "/__up") { mode = "up"; return res.end("now UP\n"); }
  if (mode === "down") { res.statusCode = 500; return res.end("Internal Server Error"); }
  res.end("I am healthy!");
}).listen(Number(process.env.FLAKY_PORT) || 4000, () => console.log("Flaky test site on http://localhost:4000  (/__up  /__down)"));
