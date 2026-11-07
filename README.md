# HealthyLife

HealthyLife is a small wellness platform with a React web app, an Expo Android/iOS app, and an Express API.

## Run locally

Requirements: Node.js 22.13+ and npm.

```sh
npm ci
npm run dev:api
npm run dev:web
npm run dev:mobile
```

The API listens on port 4000. For local development it uses temporary in-memory data unless `MONGODB_URI` is set. Set the mobile and web API URLs in their respective environment variables when testing on a phone or against a deployed API.

## Deployment layout

- **Vercel** serves the web app from the monorepo root using `vercel.json`. Set `VITE_API_URL` to the Render API URL ending in `/api`.
- **Render** runs the API from the monorepo root using `render.yaml`. Set `MONGODB_URI` to the Atlas application connection string and `CORS_ORIGINS` to the exact Vercel site origin. Render generates `JWT_SECRET` from the Blueprint.
- **MongoDB Atlas** stores users, favorites, activities, and device summaries. Use a database user with access limited to the `healthylife` database. Keep the connection string private in Render.
- **Expo EAS** uses the `preview` profile to build an installable Android APK. The EAS build page supplies the install link and QR. Set `EXPO_PUBLIC_API_URL` to the deployed Render API URL for the build.

## First-time service setup

1. Create a free Atlas cluster, a database user, and an IP access rule for the API host. Copy the application connection string; do not put it in GitHub.
2. Import the repository into Render as a Blueprint and enter `MONGODB_URI` and the Vercel origin when prompted.
3. Import the same GitHub repository into Vercel. Keep the project root at `.` and add `VITE_API_URL` using the API URL from Render.
4. Link this app to the Expo account and set the EAS project ID. Build and set the `EXPO_PUBLIC_API_URL` environment variable, then run `eas build --platform android --profile preview`.

The GitHub repository starts empty. Seed it with these project files before importing it into Render or Vercel.

## Privacy and security notes

Use HTTPS service URLs, keep database and signing credentials only in provider environment settings, and limit Atlas network access to Render's published outbound IP ranges for the API region. Avoid allowing connections from every IP. The demo web client stores its session token in local storage; review authentication and privacy requirements before broad public use.
