import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import AuthShell from "./AuthShell";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const errorSummary = useMemo(() => {
    const items = Object.values(errors).filter(Boolean);
    return formError ? [formError, ...items] : items;
  }, [errors, formError]);

  function validate() {
    const next = {};
    if (!isValidEmail(email)) next.email = "Please enter a valid email address.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setFormError("");
    setSent(false);

    if (!validate()) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim() }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setFormError("We could not process your reset request right now. Please try again.");
        return;
      }

      setSent(true);
    } catch {
      setFormError("We could not process your reset request right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we will send reset instructions."
      sidePanel={
        <div className="space-y-3 text-sm text-slate-600">
          <p>
            Use the same email address you signed up with. If your account exists, we will
            send a reset link.
          </p>
          <p>
            Need to sign in with Hub? Return to sign in and select <strong>Continue with Hub</strong>.
          </p>
        </div>
      }
    >
      {errorSummary.length > 0 ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" aria-live="polite">
          <p className="font-semibold">Please fix the following:</p>
          <ul className="mt-1 list-disc pl-5">
            {errorSummary.map((item, idx) => (
              <li key={`${item}-${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {sent ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" aria-live="polite">
          If the email exists, reset instructions have been sent.
        </div>
      ) : null}

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="forgot-email">
            Email address
          </label>
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            autoComplete="email"
          />
          {errors.email ? <p className="mt-1 text-xs text-rose-700">{errors.email}</p> : null}
        </div>

        <div className="space-y-3">
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700"
          >
            {submitting ? "Sending..." : "Send reset link"}
          </button>

          <Link
            to="/login"
            className="block w-full rounded-xl border border-transparent px-4 py-2.5 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
