🗳️ QR Authenticated Voting System

VoterScan is a full-stack, QR-code + facial-recognition based voting authentication platform built for colleges and institutions to run secure, time-boxed elections. It replaces manual ID verification with a scan-and-vote flow, while giving admins fine-grained control over voter eligibility, scheduling, and result publication.

Live badge ideas: Node.js Express Supabase PWA Face Recognition


✨ Key Features

🔐 Authentication & Security


Email/password auth via Supabase Auth with a custom OTP-based signup and password-reset flow
Brute-force protection: in-memory failed-login tracker that locks an account for 30 minutes after 5 failed attempts
Row Level Security (RLS) policies on every Postgres table — admins only ever see their own data
JWT bearer-token verification middleware on all protected routes


🧑‍💼 Admin Panel


Create voting "sessions" scoped by college / year / semester / section
Define voter eligibility three ways per session:

UUCMS ID ranges (e.g. 1AB21CS001–1AB21CS060) with alphanumeric range-matching logic
Individual student allow-lists
Named credentials with an explicit can-vote / view-only flag



Automatic conflict detection engine — before creating, editing, or publishing a session, the backend cross-checks voting/result time windows against every other session owned by the admin and flags overlapping student IDs, ranges, or credentials to prevent double-voting setups
Candidate management with photo upload to Supabase Storage (signed URLs)
Schedule and publish results in a separate, independently time-boxed results window


📷 Voter Experience


QR-code scanning (jsQR) to identify a student and admin/session code
In-browser facial recognition (face-api.js) captured once at registration and matched on return visits — no third-party face API calls, descriptors stored directly in Postgres
Atomic, race-condition-safe vote submission (has_voted = false guard on update) to prevent duplicate votes under concurrent requests
Public, authorization-checked results page — a student can only view results if their ID falls inside an approved UUCMS range or credential list


📱 Progressive Web App


Installable PWA (manifest.json) for kiosk-style deployment on scanning stations
Custom Service Worker with a network-first strategy for HTML/API and cache-first for static assets, plus offline fallback
Custom toast/alert/confirm UI (notifications.js) replacing native browser dialogs for a more polished in-app feel



🏗️ Tech Stack

LayerTechnologyBackendNode.js, ExpressDatabase & AuthSupabase (PostgreSQL, Auth, Storage)Face Recognitionface-api.jsQR ScanningjsQRFrontendHTML5, vanilla JS, custom CSSOffline / InstallableService Worker, Web App ManifestSecurityJWT verification, RLS policies, rate limiting, OTP verification


🧩 Architecture Overview

frontend/
 ├── index.html      → Admin login / signup (OTP)
 ├── admin.html       → Admin dashboard (sessions, candidates, ranges)
 ├── qr.html           → Student-facing QR scanner (entry point / PWA start_url)
 ├── blink.html        → Face capture + registration
 ├── home.html          → Candidate list + vote casting
 ├── result.html         → Public results view
 ├── publish.html         → Admin results-publishing dashboard
 ├── sw.js / manifest.json → PWA support
 └── notifications.js       → Custom alert/confirm/toast UI

backend/
 └── server.js   → Express app: auth, sessions, conflict detection,
                    voter registration, voting, results, image proxy
database.sql    → PostgreSQL schema + RLS policies (Supabase)

Core Flow


Student scans a QR / enters ID on qr.html → backend resolves eligibility (/api/verify/student)
First-time voters are routed to blink.html to capture a face descriptor
Returning voters land on home.html, authenticated by descriptor match, and cast a vote
Admin can publish results for a separate time window on publish.html; eligible students view them on result.html
