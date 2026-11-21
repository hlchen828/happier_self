package dev.happier.petoverlay

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierPetOverlayModule : Module() {
  private fun context(): ReactContext = requireNotNull(appContext.reactContext as? ReactContext) { "React app context unavailable" }

  override fun definition() = ModuleDefinition {
    Name("HappierPetOverlay")
    Events("onStateChanged", "onAction", "onError")

    OnStartObserving("onStateChanged") {
      PetOverlayBridge.stateListener = { sendEvent("onStateChanged", it) }
    }
    OnStopObserving("onStateChanged") { PetOverlayBridge.stateListener = null }
    OnStartObserving("onAction") {
      PetOverlayBridge.actionListener = { sendEvent("onAction", it) }
    }
    OnStopObserving("onAction") { PetOverlayBridge.actionListener = null }
    OnStartObserving("onError") {
      PetOverlayBridge.errorListener = { sendEvent("onError", it) }
    }
    OnStopObserving("onError") { PetOverlayBridge.errorListener = null }
    OnDestroy {
      PetOverlayBridge.actionListener = null
      PetOverlayBridge.stateListener = null
      PetOverlayBridge.errorListener = null
      val service = PetOverlayBridge.service
      Handler(Looper.getMainLooper()).post { service?.shutdown() }
    }
    OnActivityEntersForeground {
      PetOverlayBridge.onAppForegroundChanged(true)
      PetOverlayBridge.stateListener?.invoke(PetOverlayBridge.state(context()))
    }
    OnActivityEntersBackground {
      PetOverlayBridge.onAppForegroundChanged(false)
    }

    AsyncFunction("getState") {
      PetOverlayBridge.state(context())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestPermission") {
      val activity = requireNotNull(appContext.currentActivity) { "Foreground activity required" }
      activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}")))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("start") { raw: String, promise: Promise ->
      val context = context()
      PetOverlayBridge.awaitStart(promise)
      try {
        val payload = PetPayload.parse(raw)
        if (!Settings.canDrawOverlays(context)) throw SecurityException("System overlay permission is required to start the pet overlay")
        val activity = requireNotNull(appContext.currentActivity) { "Foreground activity required" }
        require(activity.hasWindowFocus()) { "Overlay must be started while app is foreground" }
        PetOverlayBridge.onAppForegroundChanged(true)
        val service = PetOverlayBridge.service
        if (PetOverlayBridge.running && service != null) {
          service.update(payload)
          PetOverlayBridge.publish(context, PetOverlayBridge.running)
        } else {
          PetOverlayBridge.reactContext = context
          PetOverlayBridge.pendingPayload = payload
          val intent = Intent(context, PetOverlayService::class.java)
          if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
      } catch (error: Exception) {
        try { PetOverlayBridge.failStart(context, error) }
        finally {
          PetOverlayBridge.service?.shutdown()
          PetOverlayBridge.clearStopped()
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      PetOverlayBridge.pendingPayload = null
      PetOverlayBridge.service?.shutdown()
      context().stopService(Intent(context(), PetOverlayService::class.java))
      PetOverlayBridge.publish(context(), false)
      PetOverlayBridge.clearStopped()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("update") { raw: String ->
      val payload = PetPayload.parse(raw)
      PetOverlayBridge.service?.update(payload)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("takePendingActions") {
      PetOverlayBridge.takePendingActions()
    }.runOnQueue(Queues.MAIN)
  }
}
