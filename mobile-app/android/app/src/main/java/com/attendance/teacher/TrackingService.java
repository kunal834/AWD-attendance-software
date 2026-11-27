package com.attendance.teacher;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class TrackingService extends Service {
    private static final String CHANNEL = "attendance_tracking";
    private static final int NOTIFICATION = 1;
    static volatile int activeShift;
    private ScheduledExecutorService worker;
    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private volatile Location latest;
    private volatile int generation;
    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location fix) { latest = fix; }
        @Override public void onProviderEnabled(String provider) {}
        @Override public void onProviderDisabled(String provider) { latest = null; }
        @Override public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        reset();
        int shiftId = intent.getIntExtra("shiftId", 0);
        String base = intent.getStringExtra("base");
        String token = intent.getStringExtra("token");
        try {
            NotificationManager notifications = getSystemService(NotificationManager.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Attendance tracking", NotificationManager.IMPORTANCE_LOW));
            startForeground(NOTIFICATION, notification("Waiting for a GPS fix"));
            locationManager = getSystemService(LocationManager.class);
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0, listener);
            wakeLock = getSystemService(PowerManager.class).newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, "attendance:tracking");
            wakeLock.acquire();
            activeShift = shiftId;
            int currentGeneration = generation;
            worker = Executors.newSingleThreadScheduledExecutor();
            worker.scheduleAtFixedRate(() -> send(base, token, shiftId, startId, currentGeneration),
                15, 15, TimeUnit.SECONDS);
        } catch (RuntimeException error) {
            reset();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification notification(String text) {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent openApp = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE);
        return new androidx.core.app.NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Attendance location tracking")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build();
    }

    private void update(String message, int currentGeneration) {
        if (generation == currentGeneration) {
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(message));
        }
    }

    private void send(String base, String token, int shiftId, int startId, int currentGeneration) {
        Location fix = latest;
        if (fix == null || SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()
                > TimeUnit.SECONDS.toNanos(60)) {
            update("Waiting for a GPS fix", currentGeneration);
            return;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/api/location").openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            JSONObject data = new JSONObject().put("shiftId", shiftId)
                .put("latitude", fix.getLatitude()).put("longitude", fix.getLongitude());
            try (OutputStream output = connection.getOutputStream()) {
                output.write(data.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code == 401 || code == 403 || code == 409) {
                stopSelf(startId);
            } else if (code == 204) {
                update("Location sent at " + java.text.DateFormat.getTimeInstance().format(new java.util.Date()),
                    currentGeneration);
            } else {
                update("Location send failed. Retrying…", currentGeneration);
            }
        } catch (Exception error) {
            update("Connection interrupted. Retrying…", currentGeneration);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void reset() {
        generation++;
        activeShift = 0;
        if (worker != null) { worker.shutdownNow(); worker = null; }
        if (locationManager != null) { locationManager.removeUpdates(listener); locationManager = null; }
        if (wakeLock != null) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
        }
        latest = null;
    }

    @Override
    public void onDestroy() {
        reset();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}


