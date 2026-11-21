package dev.happier.petoverlay

import android.content.Context
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.Promise

internal object PetOverlayBridge {
  @Volatile var running = false
    private set
  @Volatile var service: PetOverlayService? = null
  @Volatile var appForeground = true
    private set

  fun onAppForegroundChanged(foreground: Boolean) {
    appForeground = foreground
    service?.updatePresentation()
  }
  var pendingPayload: PetPayload? = null
  @Volatile var reactContext: ReactContext? = null
  private val starts = mutableListOf<Promise>()
  private val pendingActions = mutableListOf<Map<String, String>>()
  @Volatile var actionListener: ((Map<String, String>) -> Unit)? = null
  @Volatile var stateListener: ((Map<String, Boolean>) -> Unit)? = null
  @Volatile var errorListener: ((Map<String, String>) -> Unit)? = null

  fun state(context: Context): Map<String, Boolean> = mapOf("running" to running, "permissionGranted" to Settings.canDrawOverlays(context))

  fun awaitStart(promise: Promise) {
    starts.add(promise)
  }

  fun failStart(context: Context, error: Throwable) {
    val waiting = starts.toList()
    starts.clear()
    pendingPayload = null
    Log.e("HappierPetOverlay", "Overlay failed", error)
    waiting.forEach { it.reject("ERR_PET_OVERLAY", error.message ?: "Overlay failed", error) }
    publish(context, false)
    errorListener?.invoke(mapOf("message" to (error.message ?: "Overlay failed")))
  }

  @Synchronized fun clearStopped() {
    pendingActions.clear()
    pendingPayload = null
    reactContext = null
  }

  fun publish(context: Context, isRunning: Boolean) {
    running = isRunning
    val state = state(context)
    stateListener?.invoke(state)
    val waiting = starts.toList()
    starts.clear()
    waiting.forEach { it.resolve(state) }
  }

  @Synchronized fun action(action: Map<String, String>) {
    val listener = actionListener
    if (listener == null) pendingActions.add(action) else listener(action)
  }

  @Synchronized fun takePendingActions(): List<Map<String, String>> {
    val actions = pendingActions.toList()
    pendingActions.clear()
    return actions
  }
}
