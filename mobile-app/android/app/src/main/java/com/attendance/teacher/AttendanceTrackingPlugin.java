package com.attendance.teacher;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AttendanceTracking")
public class AttendanceTrackingPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String base = call.getString("base", "");
        String token = call.getString("token", "");
        int shiftId = call.getInt("shiftId", 0);
        if (!(base.startsWith("https://") || (((getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) && base.startsWith("http://")))
                || token.isEmpty() || shiftId <= 0) {
            call.reject("Set a valid server URL and sign in before starting tracking.");
            return;
        }
        Intent intent = new Intent(getContext(), TrackingService.class);
        intent.putExtra("base", base);
        intent.putExtra("token", token);
        intent.putExtra("shiftId", shiftId);
        try {
            androidx.core.content.ContextCompat.startForegroundService(getContext(), intent);
            getActivity().getWindow().getDecorView().postDelayed(() -> {
                if (TrackingService.activeShift == shiftId) call.resolve();
                else call.reject("Tracking could not start. Check location permissions and try again.");
            }, 1000);
        } catch (RuntimeException error) {
            call.reject("Keep the app visible and allow location access to start tracking.", error);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject state = new JSObject();
        state.put("shiftId", TrackingService.activeShift);
        call.resolve(state);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), TrackingService.class));
        call.resolve();
    }
}


