# Neon migration workspace

This repository is a static GitHub Pages site. The Typing Unit currently uses Supabase REST, Supabase Auth, and a Supabase Edge Function. Neon provides PostgreSQL, but does **not** replace Supabase Auth or Edge Functions. Do not switch the live page to a Neon connection string: database credentials must remain server-side.

## Open a terminal-enabled workspace

1. Open the repository on GitHub.
2. Select **Code → Codespaces → Create codespace on main**. The `.devcontainer/devcontainer.json` file configures Node.js 22.
3. In the Codespaces terminal, run:

```sh
npm i -g neon@latest
```

If that package command fails, try `npx neon@latest` in place of `neon` for the CLI commands. If a command opens a browser sign-in, finish sign-in in that browser tab. If it times out or fails, run `neon login` and retry.

## Requested Neon initialization

Run the user's requested commands from the repository root, in this order:

```sh
neon init -y --org-id org-still-salad-53776944 --project-id still-frost-29003479 --branch production --services postgres
neon deploy
```

If using `npx neon@latest`, prefix each CLI command with `npx neon@latest`.

Review generated files before committing. Keep `.env` and `.env.local` out of Git; never paste database connection strings into source code or public GitHub files.

## Migration safety checklist

- Back up the current Supabase `typing_students` and `typing_results` records before any schema or data changes.
- Preserve the current columns and result history. Test imports into Neon and compare row counts and representative rows.
- Implement a server-side API that connects to Neon using server-only environment variables. GitHub Pages cannot host that API; deploy it to a server-capable host.
- The Typing Unit also uses Supabase Auth for teacher sign-in/password recovery and a Supabase Edge Function named `delete-student` for protected deletion. Keep those services working during the database migration, or explicitly design and test replacements before removing Supabase.
- Do not change the live Typing Unit to Neon until student listing, result loading/saving, teacher sign-in, password recovery, student rename, and authorized result deletion have been tested end to end.

## Build/test status

This repository currently has no root `package.json` or build script. Do not report `npm run build` as passing until a real build script is defined and executed. The static HTML app should also be syntax-checked and its database workflows tested against a non-production/test dataset before release.
