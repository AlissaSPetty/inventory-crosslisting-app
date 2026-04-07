import { useState } from "react";
import { supabase } from "../lib/supabase.js";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const { error } = await supabase.auth.signUp({ email, password });
    setMsg(error ? error.message : "Check your email to confirm, then sign in.");
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setMsg(error ? error.message : null);
  }

  return (
    <div className="layout" style={{ maxWidth: 420 }}>
      <h1>Inventory crosslisting</h1>
      <p>Sign in with Supabase Auth (email/password).</p>
      <form className="card" onSubmit={signIn}>
        <div style={{ marginBottom: "0.75rem" }}>
          <label>
            Email
            <br />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: "100%" }}
            />
          </label>
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label>
            Password
            <br />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: "100%" }}
            />
          </label>
        </div>
        <button className="primary" type="submit">
          Sign in
        </button>{" "}
        <button type="button" onClick={signUp}>
          Sign up
        </button>
        {msg && <p className={msg.startsWith("Check") ? "" : "error"}>{msg}</p>}
      </form>
    </div>
  );
}
