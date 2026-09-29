import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api.js";
import { navigate } from "../lib/router.js";
import type { TestPreview } from "../lib/types.js";

const TOKEN_KEY = "bfx-token";

/** /t/<token>: explain the test, then start it. The token leaves the address bar immediately. */
export function Landing({ token: fromUrl }: { token: string }) {
  const [token] = useState(() => {
    if (fromUrl) sessionStorage.setItem(TOKEN_KEY, fromUrl);
    return fromUrl || sessionStorage.getItem(TOKEN_KEY) || "";
  });
  const [preview, setPreview] = useState<TestPreview>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    history.replaceState(null, "", "/start");
    let cancelled = false;
    (async () => {
      try {
        // A test already under way in this browser takes priority. A finished one does not:
        // this link starts a new test.
        const view = await api.session();
        if (!cancelled && view.state !== "finished" && view.state !== "failed") {
          navigate("/session", true);
          return;
        }
      } catch {
        // no session in this browser yet
      }
      try {
        const p = await api.preview(token);
        if (!cancelled) setPreview(p);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Something went wrong. Reload the page to try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const start = async () => {
    setStarting(true);
    try {
      await api.start(token);
      sessionStorage.removeItem(TOKEN_KEY);
      navigate("/session", true);
    } catch (err) {
      setStarting(false);
      setError(err instanceof ApiError ? err.message : "The test could not be started. Try again.");
    }
  };

  return (
    <main className="center-page">
      <div className="card card-wide">
        <p className="eyebrow">Network troubleshooting test</p>
        {error && (
          <>
            <h1>Can't open this test</h1>
            <p className="error" role="alert">
              {error}
            </p>
          </>
        )}
        {!error && !preview && <p className="muted">Checking your link…</p>}
        {!error && preview && (
          <>
            <h1 data-testid="test-title">{preview.title}</h1>
            <p className="meta">
              <span className={`badge badge-${preview.difficulty}`}>{preview.difficulty}</span>
              <span>{preview.timeLimitMinutes} minutes</span>
              <span>{preview.devices} devices</span>
            </p>
            <ul className="rules">
              <li>You get a live network of real routers and hosts. A ticket describes what is broken.</li>
              <li>Click a device in the diagram to open its terminal. Routers give you the full router CLI (FRRouting vtysh, close to Cisco IOS); hosts offer ping, traceroute and ip.</li>
              <li>The timer starts when your lab is ready. Submit when you are done; at the end of the time your work is submitted automatically.</li>
              <li>Fix the root cause. The checks look at how the network was fixed, not only whether pings work.</li>
              <li>Everything you type is recorded and shown on your results page.</li>
            </ul>
            <button className="btn btn-primary btn-large" onClick={start} disabled={starting} data-testid="start">
              {starting ? "Starting…" : "Start the test"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
