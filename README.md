# Attendance software

## Start locally

Use Node.js 24 LTS or a newer supported version. From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm.cmd ci
npm.cmd run dev
```

Set your admin email and password before starting. They seed the admin on the first run. SQLite data lives in `backend/attendance.sqlite`. Leave `VITE_API_URL` empty for browser development so Vite proxies requests and sockets to Express.

1. Open the [admin dashboard](http://localhost:5173) and sign in with the credentials from `.env`. Add a teacher and share their initial password.
2. Open the [teacher app](http://localhost:5174), sign in and grant location access. Check in and leave the page open to see your pin update every 15 seconds when a current fix is available.
3. Check out to stop tracking and remove the pin. The attendance table keeps both sets of coordinates. Map tiles require internet access.

Phone browsers require HTTPS for GPS. For an Android phone on the same Wi-Fi, use a debug APK and the LAN setup below.

## Android APK

Install Android Studio with SDK 36. Set `VITE_ANDROID_API_URL` in the root `.env` to the address reachable from the phone, such as `http://192.168.1.20:3000` for a local debug build. Keep Express running and allow the port through the local firewall if needed.

Run `npm.cmd run android:sync -w mobile-app`, open `mobile-app/android` in Android Studio and build a debug APK. Copy `mobile-app/android/app/build/outputs/apk/debug/app-debug.apk` to `apk-releases/attendance.apk`. The dashboard enables **Download APK** when that file is present. Use an HTTPS server URL for a signed release APK.

On Android, allow precise location and enable notifications to see tracking status. Check in with the activity visible. The Android foreground service keeps tracking when minimized or locked. Network outages can interrupt delivery. Reopen the app and tap **Resume tracking** if Android stopped the service. The browser app tracks only while its page is open.

