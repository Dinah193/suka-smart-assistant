# Auth Pages UX Spec

## Purpose
- Define exact UX requirements for auth surfaces so implementation is consistent across design, frontend, and backend integration.

## Scope
- Sign-in page.
- Create-account page.
- Shared auth shell components.
- Hub-only feature hinting behavior.

## Product Model
- SSA supports native accounts for all visitors.
- SSA supports free and paid levels.
- Hub sign-in is optional.
- Hub credentials are invite-only and unlock Hub-only feature surfaces.
- A person can belong to exactly one household.

## Global Layout
- Desktop: two-column auth shell.
- Left column: form card with all actions.
- Right column: value panel with free/paid + Hub messaging.
- Mobile: single-column stack, form first, value panel second.
- Max content width: 1120px.
- Form card width: 420px to 480px.

## Shared Visual Rules
- Primary CTA buttons fill container width.
- Secondary auth options remain visually equivalent in width and hierarchy.
- Hub sign-in button uses neutral style with Hub icon on the left.
- Password fields include show/hide toggle.
- All validation errors appear inline below field and in aria-live summary at top of form.

## Page: Sign In

### Heading and Intro Copy
- Title: Welcome back
- Subtitle: Sign in to Suka Smart Assistant.

### Form Fields and Order
1. Email address
2. Password
3. Remember me checkbox
4. Forgot password link

### Action Buttons (Exact Order)
1. Sign in (primary)
2. Continue with Hub (secondary oauth-style button)
3. Divider text: or
4. Create a free account (tertiary text button/link)

### Supporting Copy
- Below Hub button:
  - Have Suka Village Family Fund Hub access? Continue with Hub to unlock Hub-linked features.

### Error Copy
- Invalid credentials:
  - We could not sign you in with that email and password.
- Hub auth unavailable:
  - Hub sign-in is temporarily unavailable. You can still sign in with your Suka account.
- Locked account:
  - Your account is temporarily locked. Try again in 15 minutes or reset your password.

## Page: Create Account

### Heading and Intro Copy
- Title: Create your Suka account
- Subtitle: Start free. Upgrade anytime.

### Form Fields and Order
1. First name
2. Last name
3. Email address
4. Password
5. Confirm password
6. Terms and privacy consent checkbox

### Action Buttons (Exact Order)
1. Create free account (primary)
2. Continue with Hub (secondary oauth-style button)
3. Divider text: or
4. Sign in to existing account (tertiary text button/link)

### Supporting Copy
- Free and paid message block:
  - Free plan includes core household planning features.
  - Paid plans add advanced automation, collaboration controls, and expanded limits.
- Hub note below Hub button:
  - Already invited to Suka Village Family Fund Hub? Continue with Hub to link access.

### Validation Copy
- Email already exists:
  - An account already exists for this email. Try signing in instead.
- Weak password:
  - Password must be at least 10 characters and include one number.
- Consent missing:
  - You must accept the terms and privacy policy to create an account.

## Hub-Only Feature Hinting

### Where Hints Appear
- Auth pages right-side value panel.
- Post-auth dashboard banners when user is SSA-only.
- Locked feature cards across modules.

### Hint Display Rules
- Show Hub hint when user is not signed in.
- Show Hub hint when user is signed in with SSA account but no linked Hub entitlement.
- Do not show Hub hint when user has valid Hub-linked entitlement.
- Do not block non-Hub features behind Hub hint overlays.

### Locked Card Microcopy (Exact)
- Title: Hub access required
- Body: This feature is available to Suka Village Family Fund Hub members.
- CTA 1: Continue with Hub
- CTA 2: Learn about Hub access

### Dashboard Banner (SSA-only signed-in user)
- Title: Unlock Hub-linked features
- Body: Connect your Hub account to access member-only tools in select modules.
- CTA: Continue with Hub

## Free/Paid Messaging Rules
- Never imply paid is required for basic account creation.
- On create-account page always show:
  - Start free. Upgrade anytime.
- On sign-in page show paid upsell only in side panel, never inside the credential form.
- Paid messaging must not mention Hub as a paid tier; Hub is entitlement-based, not a plan tier.

## Button Behavior Requirements
- Continue with Hub button routes to Hub auth start endpoint.
- On successful Hub auth:
  - If SSA account exists and can link, continue signed-in and mark Hub-linked.
  - If SSA account does not exist, create SSA identity shell and continue onboarding.
- If Hub auth fails, return user to prior auth page with non-destructive error toast and inline message.

## Accessibility Requirements
- Every input has programmatic label.
- Error summary region has aria-live="polite".
- Keyboard tab order follows visual order.
- Divider text "or" is read by screen readers once.
- Button accessible names:
  - Sign in
  - Create free account
  - Continue with Hub

## Analytics Events
- auth_viewed with page_type: sign_in | create_account
- auth_submit_native_clicked
- auth_submit_hub_clicked
- auth_success_native
- auth_success_hub
- auth_failure_native
- auth_failure_hub
- auth_hub_hint_shown with location

## QA Acceptance Checklist
- Button order exactly matches this spec on both pages.
- Copy strings match exactly, including capitalization.
- Free/paid text visible on create-account page.
- Hub button present on sign-in and create-account pages.
- Hub-only hints appear only when rules match.
- Mobile layout keeps all primary/secondary auth CTAs above first fold where possible.

## Implementation Notes
- Keep Hub auth action as optional path, never replacing native account path.
- Keep free and paid plan messaging separate from Hub entitlement messaging.
- Maintain one-household constraint in downstream onboarding and household assignment steps.
