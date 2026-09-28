import { Suspense, lazy } from "react";
import { usePath } from "./lib/router.js";
import { Home } from "./pages/Home.js";
import { Landing } from "./pages/Landing.js";

// The workspace carries xterm.js; load it (and the results page) only when needed.
const Workspace = lazy(() => import("./pages/Workspace.js").then((m) => ({ default: m.Workspace })));
const Results = lazy(() => import("./pages/Results.js").then((m) => ({ default: m.Results })));

export function App() {
  const path = usePath();
  let page;
  if (path.startsWith("/t/")) page = <Landing token={decodeURIComponent(path.slice(3))} />;
  else if (path === "/start") page = <Landing token="" />;
  else if (path === "/session") page = <Workspace />;
  else if (path === "/results") page = <Results />;
  else page = <Home />;
  return <Suspense fallback={<main className="center-page muted">Loading…</main>}>{page}</Suspense>;
}
