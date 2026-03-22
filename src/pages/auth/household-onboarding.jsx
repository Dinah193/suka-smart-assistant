import React, { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import AuthShell from "./AuthShell";
import { getToken, setToken } from "../../services/auth/tokenProvider.js";

function resolveReturnTo(search) {
  const params = new URLSearchParams(search || "");
  const candidate = String(params.get("returnTo") || "/").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  return candidate;
}

export default function HouseholdOnboardingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = useMemo(() => resolveReturnTo(location.search), [location.search]);

  const [householdName, setHouseholdName] = useState("My Household");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = String(getToken("access") || "").trim();
      if (!token) {
        if (!cancelled) navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
        return;
      }

      const res = await fetch("/api/auth/me", {
        method: "GET",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => null);
      const payload = res ? await res.json().catch(() => ({})) : {};

      if (cancelled) return;

      if (!res || !res.ok || !payload?.ok) {
        navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
        return;
      }

      const existingHouseholdId = String(payload?.user?.householdId || "").trim();
      if (existingHouseholdId) {
        navigate(returnTo, { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, returnTo]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    const trimmedName = String(householdName || "").trim();
    if (!trimmedName) {
      setError("Please enter a household name.");
      return;
    }

    setSubmitting(true);
    try {
      const token = String(getToken("access") || "").trim();
      const res = await fetch("/api/auth/household/bootstrap", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ householdName: trimmedName }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok || !payload?.ok) {
        const reason = String(payload?.error || "").toLowerCase();
        if (reason.includes("locked")) {
          setError("Your account is already linked to a household and cannot be reassigned.");
        } else {
          setError("We could not complete household setup right now. Please try again.");
        }
        return;
      }

      const refreshedToken = String(payload?.session?.accessToken || "").trim();
      if (refreshedToken) {
        setToken(refreshedToken, { kind: "access", source: "auth.household.onboarding" });
      }

      const user = payload?.user || {};
      const identity = {
        id: user.id || user.userId || null,
        userId: user.userId || user.id || null,
        email: user.email || null,
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

      navigate(returnTo, { replace: true });
    } catch {
      setError("We could not complete household setup right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Set up your household"
      subtitle="Confirm your household name to continue."
      sidePanel={
        <div className="space-y-3 text-sm text-slate-600">
          <p>
            Each account belongs to one household. You can collaborate across households by module,
            but membership remains single-household.
          </p>
          <p>
            Once linked, your household membership is locked unless support performs a verified
            account migration.
          </p>
        </div>
      }
    >
      {error ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" aria-live="polite">
          {error}
        </div>
      ) : null}

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-800" htmlFor="household-name">
            Household name
          </label>
          <input
            id="household-name"
            type="text"
            value={householdName}
            onChange={(e) => setHouseholdName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            maxLength={80}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700"
        >
          {submitting ? "Saving household..." : "Continue"}
        </button>
      </form>
    </AuthShell>
  );
}
