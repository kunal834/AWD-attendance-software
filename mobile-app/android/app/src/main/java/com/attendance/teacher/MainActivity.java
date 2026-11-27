package com.attendance.teacher;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(AttendanceTrackingPlugin.class);
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED
                && !getPreferences(MODE_PRIVATE).getBoolean("notificationRequested", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("notificationRequested", true).apply();
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }
}
