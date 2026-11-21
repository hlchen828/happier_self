package dev.happier.petoverlay

import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

class PetOverlayService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var overlay: PetOverlayView? = null
  private var registeredScreenReceiver = false
  private var watchingPermission = false
  private var stopping = false
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskId: Int? = null
  private val permissionListener = AppOpsManager.OnOpChangedListener { operation, packageName ->
    if (operation == AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW && packageName == this.packageName) {
      handler.post { checkPermission() }
    }
  }
  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      checkPermission()
      overlay?.setScreenInteractive(intent.action != Intent.ACTION_SCREEN_OFF)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    PetOverlayBridge.service = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null || intent.action == STOP || stopping) {
      shutdown()
      return START_NOT_STICKY
    }
    val payload = PetOverlayBridge.pendingPayload
    PetOverlayBridge.pendingPayload = null
    if (payload == null && PetOverlayBridge.running) return START_NOT_STICKY
    if (payload == null) {
      shutdown()
      return START_NOT_STICKY
    }
    try {
      check(Settings.canDrawOverlays(this)) { "System overlay permission is required to start the pet overlay" }
      val notification = notification(payload)
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      if (overlay == null) {
        overlay = PetOverlayView(this, ::open, ::dismiss, ::shutdown, ::spriteError)
      }
      overlay?.update(payload)
      overlay?.setScreenInteractive(getSystemService(PowerManager::class.java).isInteractive)
      updatePresentation()
      if (stopping) return START_NOT_STICKY
      if (!registeredScreenReceiver) {
        val filter = IntentFilter().apply {
          addAction(Intent.ACTION_SCREEN_OFF)
          addAction(Intent.ACTION_SCREEN_ON)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, filter)
        registeredScreenReceiver = true
      }
      if (!watchingPermission) {
        getSystemService(AppOpsManager::class.java).startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, packageName, permissionListener)
        watchingPermission = true
      }
      startRuntimeTask()
      PetOverlayBridge.publish(this, true)
    } catch (error: Exception) {
      try { PetOverlayBridge.failStart(this, error) }
      finally { shutdown() }
    }
    return START_NOT_STICKY
  }

  internal fun update(payload: PetPayload) {
    if (stopping || !checkPermission()) return
    overlay?.update(payload)
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(payload))
  }

  internal fun updatePresentation() {
    if (stopping || !checkPermission()) return
    try {
      if (PetOverlayBridge.appForeground) overlay?.hide() else overlay?.attach()
    } catch (error: Exception) {
      try { PetOverlayBridge.failStart(this, error) }
      finally { shutdown() }
    }
  }

  internal fun startRuntimeTask() {
    if (taskId != null) return
    val runtime = checkNotNull(PetOverlayBridge.reactContext) { "Existing React runtime is required for the pet overlay" }
    check(runtime.hasActiveReactInstance()) { "Existing React runtime must be active to start the pet overlay" }
    val tasks = HeadlessJsTaskContext.getInstance(runtime)
    taskContext = tasks
    taskId = tasks.startTask(HeadlessJsTaskConfig("HappierPetOverlay", Arguments.createMap(), 0, true))
    check(tasks.isTaskRunning(requireNotNull(taskId))) { "Pet overlay headless task did not start" }
  }

  private fun finishRuntimeTask() {
    val tasks = taskContext
    val id = taskId
    taskContext = null
    taskId = null
    if (tasks != null && id != null && tasks.isTaskRunning(id)) tasks.finishTask(id)
  }

  private fun spriteError(error: Throwable) {
    if (stopping) return
    try { PetOverlayBridge.failStart(this, error) }
    finally { shutdown() }
  }

  internal fun checkPermission(): Boolean {
    val granted = Settings.canDrawOverlays(this)
    if (!granted) shutdown()
    return granted
  }

  internal fun shutdown() {
    stopping = true
    PetOverlayBridge.pendingPayload = null
    overlay?.detach()
    overlay = null
    finishRuntimeTask()
    PetOverlayBridge.clearStopped()
    stopForeground(STOP_FOREGROUND_REMOVE)
    PetOverlayBridge.publish(this, false)
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    overlay?.detach()
    overlay = null
    finishRuntimeTask()
    PetOverlayBridge.clearStopped()
    if (registeredScreenReceiver) unregisterReceiver(screenReceiver)
    if (watchingPermission) getSystemService(AppOpsManager::class.java).stopWatchingMode(permissionListener)
    handler.removeCallbacksAndMessages(null)
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (PetOverlayBridge.service === this) PetOverlayBridge.service = null
    PetOverlayBridge.publish(this, false)
    super.onDestroy()
  }

  private fun open(sessionId: String?) {
    if (!checkPermission()) return
    val manager = getSystemService(ActivityManager::class.java)
    val task = manager.appTasks.firstOrNull { it.taskInfo.baseIntent.component?.packageName == packageName }
    var moved = false
    if (task != null) {
      try {
        task.moveToFront()
        moved = true
      } catch (error: RuntimeException) {
        moved = false
      }
    }
    if (!moved) {
      val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
      launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      try {
        startActivity(launch)
      } catch (error: RuntimeException) {
        return
      }
    }
    PetOverlayBridge.action(if (sessionId == null) mapOf("type" to "open") else mapOf("type" to "openSession", "sessionId" to sessionId))
  }

  private fun dismiss(item: PetItem) {
    PetOverlayBridge.action(mapOf("type" to "dismiss", "sessionId" to item.sessionId, "dismissKey" to item.dismissKey))
  }

  private fun notification(payload: PetPayload): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, payload.labels.title, NotificationManager.IMPORTANCE_LOW).apply {
        setSound(null, null)
        enableVibration(false)
      })
    }
    val stop = PendingIntent.getService(this, 0, Intent(this, PetOverlayService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    builder.setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info)
      .setContentTitle(payload.labels.title)
      .setContentText(payload.summary)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .addAction(Notification.Action.Builder(null, payload.labels.stop, stop).build())
    if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    return builder.build()
  }

  companion object {
    internal const val STOP = "dev.happier.petoverlay.STOP"
    private const val CHANNEL_ID = "happier-pet-overlay"
    private const val NOTIFICATION_ID = 7143
  }
}
