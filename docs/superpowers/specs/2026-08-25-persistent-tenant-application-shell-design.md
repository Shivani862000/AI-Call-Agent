# Persistent Tenant Application Shell Design

Date: 2026-08-25
Status: Approved in chat; awaiting written-spec review

## Problem

The tenant console is currently a collection of independent HTML documents. Each navigation click reloads the complete document, including the sidebar. Every page initially contains administrator links and removes them only after `/api/auth/session` resolves. A tenant agent can therefore see out-of-scope links briefly during each page transition.

The prior role correction makes the final rendered state correct, but it cannot prevent a full-page navigation from rebuilding the menu. The navigation lifecycle, rather than only the role selector, is the architectural root cause.

## Goals

- Keep the desktop sidebar and mobile primary navigation mounted while tenant users change screens.
- Construct navigation once from the authenticated session so unauthorized links never enter an agent's shell DOM.
- Preserve existing clean URLs such as `/admin.html` and `/customers.html`, including browser back/forward and direct reloads.
- Preserve the existing page implementations and their initialization behavior during this migration.
- Keep server-side authentication and role authorization authoritative.
- Prevent duplicate page navigation, logout controls, or restricted content from flashing while a content view loads.

## Non-goals

- Rewriting all pages as framework components.
- Changing tenant role permissions or API authorization policy.
- Reworking the Webmaster console.
- Removing page-level authorization checks; they remain defense in depth.
- Redesigning the console's visual appearance.

## Chosen Architecture

### Persistent shell

A new tenant workspace shell owns:

- brand and desktop sidebar;
- mobile primary navigation;
- authenticated session state;
- role-derived navigation policy;
- active-link state;
- logout;
- content loading, history, and transition errors.

The shell is the top-level document for tenant application routes. Existing page documents remain isolated content views in a same-origin frame. Switching screens changes only the frame source; it does not replace the shell or its menu.

This is a migration architecture. It delivers persistent navigation without coupling all existing inline page scripts into one global JavaScript lifecycle. A future component-based SPA can replace content views independently without changing the shell contract.

### Clean route dispatch

Existing URLs remain canonical:

- `/admin.html`
- `/customer-list.html`
- `/customers.html`
- `/feedback.html`
- `/feedback-analysis.html`
- `/support-tickets.html`
- `/users.html`

After authentication and role authorization middleware runs, Express distinguishes two forms of request:

1. A top-level request returns the tenant workspace shell.
2. A request with the internal `embedded=1` marker returns the existing page document as a content view.

The marker changes presentation only. It never bypasses authentication or authorization; both checks execute before shell/content dispatch. Administrator-only routes remain rejected for tenant agents even if `embedded=1` is supplied manually.

`/customer-list.html` and the shell-served tenant routes will be included in the protected HTML set. `/users.html` will be included in the administrator-only HTML policy in addition to its API and client-side checks.

### Role-derived navigation

The shell fetches `/api/auth/session` before constructing or revealing navigation.

Tenant agent navigation contains only:

- Overview
- Customer List
- Outbound Calls

Tenant administrator navigation additionally contains:

- Feedback
- Support Tickets
- Users

Reports and Incoming Calls remain disabled. The Webmaster continues to use `/webmaster.html` and is not routed through the tenant shell.

Navigation policy will be represented as data and filtered before DOM creation. Restricted links will not be rendered and then hidden.

### Content-view presentation

The content frame remains visually hidden until its document has loaded and the shell has applied an embedded-view class. That class hides the page's duplicate sidebar, mobile dock/tab bar, and duplicate logout controls, and expands the existing main panel to the frame viewport. The frame is revealed only after this preparation, preventing a duplicate or unauthorized menu flash.

The existing page script still authenticates and initializes its page data. This retains current page behavior and provides defense in depth if a content view is opened independently.

### Navigation and history

Shell navigation performs these steps:

1. Validate the target against the current role's allowed route set.
2. Update the active navigation item.
3. Push the clean target URL into browser history.
4. Load the matching content URL with `embedded=1`, preserving its query and fragment.
5. Reveal the prepared view and move focus to the view heading when appropriate.

The shell installs delegated click handling inside each same-origin content document. Links to known tenant application routes are handed to the shell, so navigation initiated from cards and actions also preserves the menu. Links, downloads, modified clicks, and unrelated URLs retain normal browser behavior.

`popstate` reloads only the content view and updates active navigation. A hard reload of any canonical route reconstructs the shell and loads the corresponding view. Route fragments, such as the outbound queue anchor, are retained.

### Loading and failure behavior

- The shell shows a neutral content loading state while the frame changes; the menu remains interactive and unchanged.
- A failed session request redirects the top-level window to `/login.html`.
- A disallowed route is never loaded by shell navigation. Direct server requests still receive the existing authorization response.
- A failed content load displays a retry action in the content region without destroying the shell.
- Logout is owned by the shell, posts to the existing logout endpoint, and redirects the top-level window.

## Components and Responsibilities

### Server route dispatcher

- Runs after authentication and authorization middleware and before static files.
- Returns the shell for top-level tenant application routes.
- Passes internal embedded requests to static page delivery.
- Does not alter Webmaster routing.

### Workspace shell HTML/CSS

- Provides stable sidebar, mobile navigation, loading/error region, and content frame.
- Contains no role-restricted navigation items before session resolution.
- Matches the existing console styling and responsive breakpoints.

### Workspace shell controller

- Resolves session once for shell policy.
- Builds allowed navigation.
- Normalizes and validates view routes.
- Coordinates frame loading, delegated internal navigation, history, active state, and logout.

### Existing page shell helper

- Retains page-level session checks and role classes.
- Detects or accepts the embedded presentation class.
- Hides duplicate chrome only when hosted by the workspace shell.

## Security Boundaries

- UI filtering is not authorization.
- Existing API middleware continues to enforce tenant scope and roles.
- HTML route authorization executes before top-level/embedded dispatch.
- The shell uses an explicit allowlist; arbitrary paths cannot be loaded as application views.
- Same-origin frame access is used only for presentation preparation and internal-link delegation.
- No credentials or session tokens are passed through frame URLs.

## Testing Strategy

Automated tests will be written before production changes and will cover:

- top-level tenant routes return the persistent shell while `embedded=1` returns their content document;
- authentication and administrator-only role enforcement occurs before embedded dispatch;
- tenant agent navigation policy excludes Feedback, Support Tickets, Users, and disabled routes;
- tenant administrator navigation includes the permitted management routes;
- navigation changes only the content source and preserves the shell navigation node;
- clean URL history, fragments, and back/forward mapping produce the correct embedded source;
- embedded preparation hides duplicate page chrome before the frame is revealed;
- direct login and root redirects continue to land on a canonical tenant route;
- existing tenant authorization and full application tests remain green.

Manual browser verification will use both tenant-agent and tenant-administrator sessions. It will confirm that repeated page switches do not repaint the menu, restricted links never flash for agents, deep links work, and responsive navigation remains usable.

## Rollout and Compatibility

Existing bookmarks and links require no URL migration. The server begins returning the shell at the same canonical tenant URLs, and the shell requests the legacy document internally. Existing content pages can later be migrated into native shell views one at a time.

The change will be implemented without altering unrelated worktree modifications.
