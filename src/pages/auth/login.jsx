import React, { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
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

export default function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");

  const errorSummary = useMemo(() => {
    const items = Object.values(errors).filter(Boolean);
    return formError ? [formError, ...items] : items;
  }, [errors, formError]);

  React.useEffect(() => {
    trackAuthEvent("auth_viewed", { page_type: "sign_in" });

    try {
      const remembered = window.localStorage?.getItem("ssa.auth.rememberEmail") || "";
      if (remembered) setEmail(String(remembered));
    } catch {
      // no-op
    }

    const params = new URLSearchParams(location.search || "");
    const hubState = String(params.get("hub") || "").trim();
    if (hubState) {
      setFormError("Hub sign-in is temporarily unavailable. You can still sign in with your Suka account.");
      trackAuthEvent("auth_failure_hub", { page_type: "sign_in", reason: hubState });
    }
  }, [location.search]);

  function validate() {
    const next = {};
    if (!isValidEmail(email)) next.email = "Please enter a valid email address.";
    if (!password) next.password = "Password is required.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setFormError("");
    trackAuthEvent("auth_submit_native_clicked", { page_type: "sign_in" });

    if (!validate()) {
      trackAuthEvent("auth_failure_native", {
        page_type: "sign_in",
        reason: "validation",
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.trim(),
          password,
          rememberMe,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        const errorText = String(payload?.error || "").toLowerCase();
        const locked = errorText.includes("lock");
        setFormError(
          locked
            ? "Your account is temporarily locked. Try again in 15 minutes or reset your password."
            : "We could not sign you in with that email and password."
        );
        trackAuthEvent("auth_failure_native", {
          page_type: "sign_in",
          reason: errorText || "invalid_credentials",
        });
        return;
      }

      const user = payload?.user || {};
      const accessToken = payload?.session?.accessToken || "";
      if (accessToken) {
        setToken(accessToken, { kind: "access", source: "auth.login" });
      }

      let identity = {
        id: user.id || user.userId || null,
        userId: user.userId || user.id || null,
        email: user.email || email.trim(),
        householdId: user.householdId || null,
        roles: Array.isArray(user.roles) ? user.roles : [],
        authProvider: user.authProvider || "native",
      };

      if (!identity.householdId && accessToken) {
        const bootstrapRes = await fetch("/api/auth/household/bootstrap", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          credentials: "include",
          body: JSON.stringify({ householdName: "My Household" }),
        });
        const bootstrapPayload = await bootstrapRes.json().catch(() => ({}));
        if (bootstrapRes.ok && bootstrapPayload?.ok) {
          const nextUser = bootstrapPayload.user || {};
          identity = {
            ...identity,
            householdId: nextUser.householdId || identity.householdId,
          };
          const refreshed = bootstrapPayload?.session?.accessToken || "";
          if (refreshed) {
            setToken(refreshed, { kind: "access", source: "auth.household.bootstrap" });
          }
        }
      }

      try {
        if (rememberMe) {
          window.localStorage?.setItem("ssa.auth.rememberEmail", email.trim());
        } else {
          window.localStorage?.removeItem("ssa.auth.rememberEmail");
        }
        window.localStorage?.setItem("suka.user", JSON.stringify(identity));
        window.localStorage?.setItem("suka.profile", JSON.stringify(identity));
      } catch {
        // no-op
      }

      window.__suka = window.__suka || {};
      window.__suka.userId = identity.userId;
      window.__suka.profile = identity;

      trackAuthEvent("auth_success_native", { page_type: "sign_in" });
      navigate("/");
    } catch {
      setFormError("We could not sign you in with that email and password.");
      trackAuthEvent("auth_failure_native", {
        page_type: "sign_in",
        reason: "network_error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onHubSignIn() {
    setFormError("");
    trackAuthEvent("auth_submit_hub_clicked", { page_type: "sign_in" });
    try {
      const returnTo = encodeURIComponent("/");
      window.location.assign(`/api/auth/hub/start?returnTo=${returnTo}`);
    } catch {
      setFormError(
        "Hub sign-in is temporarily unavailable. You can still sign in with your Suka account."
      );
      trackAuthEvent("auth_failure_hub", {
        page_type: "sign_in",
        reason: "navigation_error",
      });
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to Suka Smart Assistant."
      sidePanel={
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Plans
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">Free and paid options</h2>
            <p className="mt-2 text-sm text-slate-600">
              Free plan includes core household planning. Paid plans add expanded automation,
              collaboration controls, and higher usage limits.
            </p>
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
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="signin-email">
            Email address
          </label>
          <input
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            autoComplete="email"
          />
          {errors.email ? <p className="mt-1 text-xs text-rose-700">{errors.email}</p> : null}
        </div>

        <div>
          <label
            className="mb-1 block text-sm font-medium text-slate-800"
            htmlFor="signin-password"
          >
            Password
          </label>
          <div className="relative">
            <input
              id="signin-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 pr-24"
              autoComplete="current-password"
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

        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="signin-remember">
            <input
              id="signin-remember"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Remember me
          </label>
          <a href="/forgot-password" className="text-sm font-medium text-indigo-700 hover:underline">
            Forgot password
          </a>
        </div>

        <div className="space-y-3 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700"
          >
            {submitting ? "Signing in..." : "Sign in"}
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
            to="/create-account"
            className="block w-full rounded-xl border border-transparent px-4 py-2.5 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            Create a free account
          </Link>

          <p className="text-xs text-slate-500">
            Have Suka Village Family Fund Hub access? Continue with Hub to unlock
            Hub-linked features.
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
