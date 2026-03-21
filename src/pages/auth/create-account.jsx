import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "./AuthShell";
import { setToken } from "../../services/auth/tokenProvider.js";

function trackAuthEvent(eventName, payload = {}) {
  try {
    window.dispatchEvent(
      new CustomEvent("analytics.track", {
        detail: { eventName, payload, source: "auth.pages" },
      })
    );
  } catch {
    // no-op
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function isStrongPassword(password) {
  const value = String(password || "");
  return value.length >= 10 && /\d/.test(value);
}

export default function CreateAccountPage() {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");

  const errorSummary = useMemo(() => {
    const items = Object.values(errors).filter(Boolean);
    return formError ? [formError, ...items] : items;
  }, [errors, formError]);

  React.useEffect(() => {
    trackAuthEvent("auth_viewed", { page_type: "create_account" });
  }, []);

  function validate() {
    const next = {};
    if (!String(firstName || "").trim()) next.firstName = "First name is required.";
    if (!String(lastName || "").trim()) next.lastName = "Last name is required.";
    if (!isValidEmail(email)) next.email = "Please enter a valid email address.";
    if (!isStrongPassword(password)) {
      next.password = "Password must be at least 10 characters and include one number.";
    }
    if (password !== confirmPassword) next.confirmPassword = "Passwords do not match.";
    if (!consent) next.consent = "You must accept the terms and privacy policy to create an account.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setFormError("");
    trackAuthEvent("auth_submit_native_clicked", { page_type: "create_account" });

    if (!validate()) {
      trackAuthEvent("auth_failure_native", {
        page_type: "create_account",
        reason: "validation",
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          password,
          confirmPassword,
          consent,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        const errorText = String(payload?.error || "").toLowerCase();
        if (errorText.includes("exist") || errorText.includes("duplicate")) {
          setFormError("An account already exists for this email. Try signing in instead.");
        } else if (errorText.includes("password") || errorText.includes("weak")) {
          setFormError("Password must be at least 10 characters and include one number.");
        } else if (errorText.includes("consent")) {
          setFormError("You must accept the terms and privacy policy to create an account.");
        } else {
          setFormError("An account already exists for this email. Try signing in instead.");
        }

        trackAuthEvent("auth_failure_native", {
          page_type: "create_account",
          reason: errorText || "register_failed",
        });
        return;
      }

      const user = payload?.user || {};
      const accessToken = payload?.session?.accessToken || "";
      if (accessToken) {
        setToken(accessToken, { kind: "access", source: "auth.create_account" });
      }

      const identity = {
        id: user.id || user.userId || null,
        userId: user.userId || user.id || null,
        email: user.email || email.trim(),
        householdId: user.householdId || null,
        roles: Array.isArray(user.roles) ? user.roles : [],
        authProvider: user.authProvider || "native",
      };

      try {
        window.localStorage?.setItem("suka.user", JSON.stringify(identity));
        window.localStorage?.setItem("suka.profile", JSON.stringify(identity));
      } catch {
        // no-op
      }

      window.__suka = window.__suka || {};
      window.__suka.userId = identity.userId;
      window.__suka.profile = identity;

      trackAuthEvent("auth_success_native", { page_type: "create_account" });
      navigate("/");
    } catch {
      setFormError("An account already exists for this email. Try signing in instead.");
      trackAuthEvent("auth_failure_native", {
        page_type: "create_account",
        reason: "network_error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onHubSignIn() {
    setFormError("");
    trackAuthEvent("auth_submit_hub_clicked", { page_type: "create_account" });
    try {
      const returnTo = encodeURIComponent("/");
      window.location.assign(`/api/auth/hub/start?returnTo=${returnTo}`);
    } catch {
      setFormError(
        "Hub sign-in is temporarily unavailable. You can still sign in with your Suka account."
      );
      trackAuthEvent("auth_failure_hub", {
        page_type: "create_account",
        reason: "navigation_error",
      });
    }
  }

  return (
    <AuthShell
      title="Create your Suka account"
      subtitle="Start free. Upgrade anytime."
      sidePanel={
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Membership
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">Choose your level</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
              <li>Free plan includes core household planning features.</li>
              <li>Paid plans add advanced automation, collaboration controls, and expanded limits.</li>
            </ul>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Hub access required</p>
            <p className="mt-1 text-sm text-amber-800">
              This feature is available to Suka Village Family Fund Hub members.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onHubSignIn}
                className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700"
              >
                Continue with Hub
              </button>
              <button
                type="button"
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                Learn about Hub access
              </button>
            </div>
          </div>
        </div>
      }
    >
      {errorSummary.length > 0 ? (
        <div
          className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          aria-live="polite"
        >
          <p className="font-semibold">Please fix the following:</p>
          <ul className="mt-1 list-disc pl-5">
            {errorSummary.map((item, idx) => (
              <li key={`${item}-${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div aria-live="polite" className="sr-only" />
      )}

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="create-first-name">
            First name
          </label>
          <input
            id="create-first-name"
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            autoComplete="given-name"
          />
          {errors.firstName ? <p className="mt-1 text-xs text-rose-700">{errors.firstName}</p> : null}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="create-last-name">
            Last name
          </label>
          <input
            id="create-last-name"
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            autoComplete="family-name"
          />
          {errors.lastName ? <p className="mt-1 text-xs text-rose-700">{errors.lastName}</p> : null}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="create-email">
            Email address
          </label>
          <input
            id="create-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            autoComplete="email"
          />
          {errors.email ? <p className="mt-1 text-xs text-rose-700">{errors.email}</p> : null}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="create-password">
            Password
          </label>
          <div className="relative">
            <input
              id="create-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 pr-24"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {errors.password ? <p className="mt-1 text-xs text-rose-700">{errors.password}</p> : null}
        </div>

        <div>
          <label
            className="mb-1 block text-sm font-medium text-slate-800"
            htmlFor="create-confirm-password"
          >
            Confirm password
          </label>
          <div className="relative">
            <input
              id="create-confirm-password"
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 pr-24"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              {showConfirmPassword ? "Hide" : "Show"}
            </button>
          </div>
          {errors.confirmPassword ? (
            <p className="mt-1 text-xs text-rose-700">{errors.confirmPassword}</p>
          ) : null}
        </div>

        <div>
          <label className="flex items-start gap-2 text-sm text-slate-700" htmlFor="create-consent">
            <input
              id="create-consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>I agree to the terms and privacy policy.</span>
          </label>
          {errors.consent ? <p className="mt-1 text-xs text-rose-700">{errors.consent}</p> : null}
        </div>

        <div className="space-y-3 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700"
          >
            {submitting ? "Creating account..." : "Create free account"}
          </button>

          <button
            type="button"
            onClick={onHubSignIn}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 font-semibold text-slate-800 hover:bg-slate-50"
          >
            Continue with Hub
          </button>

          <p className="text-center text-xs text-slate-500">or</p>

          <Link
            to="/login"
            className="block w-full rounded-xl border border-transparent px-4 py-2.5 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            Sign in to existing account
          </Link>

          <p className="text-xs text-slate-500">
            Already invited to Suka Village Family Fund Hub? Continue with Hub to link access.
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
