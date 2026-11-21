package dev.happier.petoverlay

import android.app.Service
import android.content.Context
import android.view.WindowManager
import expo.modules.kotlin.events.BasicEventListener
import expo.modules.kotlin.events.EventName
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSettings
import org.robolectric.shadows.ShadowWindowManagerImpl
import android.content.Intent
import android.content.ContextWrapper
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.widget.TextView
import android.widget.ImageView
import android.view.Gravity
import android.view.MotionEvent
import org.json.JSONObject
import android.util.Base64
import android.widget.LinearLayout
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.Button
import android.view.View
import android.os.Looper
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.WritableMap
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import com.facebook.react.modules.appregistry.AppRegistry
import expo.modules.kotlin.Promise
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Implementation

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class PetOverlayTest {
  @Test
  fun packagedDrawableAtlasDecodesWithoutDensityScaling() {
    val image = Bitmap.createBitmap(8, 9, Bitmap.Config.ARGB_8888)
    val output = ByteArrayOutputStream()
    image.compress(Bitmap.CompressFormat.PNG, 100, output)
    image.recycle()
    val application = RuntimeEnvironment.getApplication()
    val resourceName = "sources_assets_pets_blink_spritesheet"
    val resources = object : Resources(application.assets, application.resources.displayMetrics, application.resources.configuration) {
      override fun getIdentifier(name: String?, defType: String?, defPackage: String?): Int {
        assertEquals(resourceName, name)
        assertEquals("drawable", defType)
        assertEquals(application.packageName, defPackage)
        return 123
      }
      override fun openRawResource(id: Int): java.io.InputStream {
        assertEquals(123, id)
        return output.toByteArray().inputStream()
      }
    }
    val context = object : ContextWrapper(application) {
      override fun getResources() = resources
    }
    val decoded = PetSpriteView.decodeImage(resourceName, PetSprite(1, 1, 8, 9, emptyMap()), 1, context)
    assertNotNull(decoded)
    assertEquals(8, decoded!!.width)
    assertEquals(9, decoded.height)
    decoded.recycle()
  }

  @Test
  fun failedStartRejectsWaitingPromiseAndEmitsErrorWithoutResolvingFalse() {
    val context = RuntimeEnvironment.getApplication()
    val promise = RecordingPromise()
    val errors = mutableListOf<Map<String, String>>()
    PetOverlayBridge.errorListener = { errors.add(it) }
    try {
      PetOverlayBridge.awaitStart(promise)
      val failure = IllegalStateException("Unable to start overlay")
      PetOverlayBridge.failStart(context, failure)
      PetOverlayBridge.publish(context, false)
      assertEquals(0, promise.resolutions)
      assertSame(failure, promise.failure)
      assertEquals(listOf(mapOf("message" to "Unable to start overlay")), errors)
      assertFalse(PetOverlayBridge.running)
    } finally {
      PetOverlayBridge.errorListener = null
    }
  }

  @Test
  fun stoppedServiceDiscardsActionsAndExistingRuntimeReference() {
    PetOverlayBridge.actionListener = null
    PetOverlayBridge.action(mapOf("type" to "openSession", "sessionId" to "old-account"))
    PetOverlayBridge.reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    controller.get().shutdown()
    controller.destroy()
    assertTrue(PetOverlayBridge.takePendingActions().isEmpty())
    assertNull(PetOverlayBridge.reactContext)
  }

  @Test
  fun headlessTaskRequiresTheSuppliedRuntimeToAlreadyBeActive() {
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    PetOverlayBridge.reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
    try {
      assertThrows(IllegalStateException::class.java) { controller.get().startRuntimeTask() }
      assertFalse(PetOverlayBridge.running)
    } finally {
      controller.destroy()
    }
  }

  @Test
  @Config(shadows = [ShadowArguments::class])
  fun headlessTaskUsesExistingRuntimeAndStopsExactlyOnceWithService() {
    val started = mutableListOf<Pair<Int, String>>()
    val registry = object : AppRegistry {
      override fun runApplication(appKey: String, appParameters: WritableMap) { fail("Must not create an application") }
      override fun unmountApplicationComponentAtRootTag(rootNodeTag: Int) { fail("Must not unmount the application") }
      override fun startHeadlessTask(taskId: Int, taskKey: String, data: WritableMap) { started.add(taskId to taskKey) }
    }
    val runtime = object : BridgeReactContext(RuntimeEnvironment.getApplication()) {
      override fun hasActiveReactInstance() = true
      override fun <ModuleType : JavaScriptModule> getJSModule(jsInterface: Class<ModuleType>): ModuleType = jsInterface.cast(registry)
    }
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    PetOverlayBridge.reactContext = runtime
    val tasks = HeadlessJsTaskContext.getInstance(runtime)
    var taskStarts = 0
    var taskFinishes = 0
    val listener = object : HeadlessJsTaskEventListener {
      override fun onHeadlessJsTaskStart(taskId: Int) { taskStarts++ }
      override fun onHeadlessJsTaskFinish(taskId: Int) { taskFinishes++ }
    }
    tasks.addTaskEventListener(listener)
    controller.get().startRuntimeTask()
    controller.get().startRuntimeTask()
    assertEquals(1, started.size)
    assertEquals("HappierPetOverlay", started.single().second)
    assertTrue(tasks.isTaskRunning(started.single().first))
    controller.get().shutdown()
    assertFalse(tasks.isTaskRunning(started.single().first))
    controller.destroy()
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(tasks.hasActiveTasks())
    assertEquals(1, taskStarts)
    assertEquals(1, taskFinishes)
    assertNull(PetOverlayBridge.reactContext)
    tasks.removeTaskEventListener(listener)
  }

  @Test
  fun disconnectedPresentationNeverClaimsAnItemIsActive() {
    val payload = PetPayload.parse(payload(connected = false))
    assertEquals("Offline", payload.status(payload.items.single()))
    assertEquals("Offline", payload.summary)
  }

  @Test
  fun connectedPresentationUsesSuppliedLocalizedStatus() {
    val payload = PetPayload.parse(payload(connected = true))
    assertEquals("Working", payload.status(payload.items.single()))
    assertEquals("Activity", payload.summary)
    assertEquals("session", payload.items.single().sessionId)
    assertEquals("dismiss", payload.items.single().dismissKey)
  }

  @Test
  fun variableFrameDurationsSelectFramesAndWrapAtCycleEnd() {
    val animation = PetAnimation(2, 3, listOf(100.0, 250.0, 50.0))
    assertEquals(0, animation.frameAt(0.0))
    assertEquals(0, animation.frameAt(99.0))
    assertEquals(1, animation.frameAt(100.0))
    assertEquals(1, animation.frameAt(349.0))
    assertEquals(2, animation.frameAt(350.0))
    assertEquals(0, animation.frameAt(400.0))
    assertEquals(1.0, animation.untilNextFrame(99.0), 0.0)
    assertEquals(250.0, animation.untilNextFrame(100.0), 0.0)
  }

  @Test
  fun durationCountMustMatchFrames() {
    assertThrows(IllegalArgumentException::class.java) {
      PetPayload.parse(payload(true).replace("\"sprite\":null", "\"sprite\":{\"cellWidth\":192,\"cellHeight\":208,\"columns\":8,\"rows\":9,\"animations\":{\"working\":{\"row\":1,\"frames\":2,\"durationsMs\":[100]}}}"))
    }
  }

  @Test
  fun accountDataUriDecodesAndRejectsMismatchedAtlasDimensions() {
    val original = Bitmap.createBitmap(8, 9, Bitmap.Config.ARGB_8888)
    val encoded = ByteArrayOutputStream().use { output ->
      original.compress(Bitmap.CompressFormat.PNG, 100, output)
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
    original.recycle()
    val uri = "data:image/png;base64,$encoded"
    val decoded = PetSpriteView.decodeImage(uri, PetSprite(1, 1, 8, 9, emptyMap()), 1)
    assertNotNull(decoded)
    assertEquals(8, decoded!!.width)
    assertEquals(9, decoded.height)
    decoded.recycle()
    val local = File.createTempFile("pet-atlas", ".png")
    try {
      local.writeBytes(Base64.decode(encoded, Base64.DEFAULT))
      val localImage = PetSpriteView.decodeImage(local.toURI().toString(), PetSprite(1, 1, 8, 9, emptyMap()), 1)
      assertNotNull(localImage)
      assertEquals(8, localImage!!.width)
      localImage.recycle()
    } finally {
      local.delete()
    }
    assertNull(PetSpriteView.decodeImage(uri, PetSprite(192, 208, 8, 9, emptyMap()), 80))
    assertNull(PetSpriteView.decodeImage("https://example.com/sprite.webp", PetSprite(1, 1, 8, 9, emptyMap()), 1))
  }

  @Test
  fun unreadableSpriteEmitsOneFailureAndReleasedSpriteDoesNotEmitLateFailure() {
    val errors = mutableListOf<Throwable>()
    val current = PetPayload.parse(payload(true)).copy(
      spriteUri = "data:image/webp;base64,bm90LWEtc3ByaXRl",
      sprite = PetSprite(192, 208, 8, 9, emptyMap())
    )
    val view = PetSpriteView(RuntimeEnvironment.getApplication(), { errors.add(it) }, InlineExecutor())
    view.update(current)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, errors.size)
    assertTrue(errors.single() is IllegalStateException)
    view.update(current)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, errors.size)
    view.release()
    val released = PetSpriteView(RuntimeEnvironment.getApplication(), { errors.add(it) }, InlineExecutor())
    released.update(current)
    released.release()
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, errors.size)
  }

  @Test
  fun invalidSpriteGeometryIsRejectedBeforeServiceStartup() {
    assertThrows(IllegalArgumentException::class.java) {
      PetPayload.parse(payload(true).replace("\"sprite\":null", "\"sprite\":{\"cellWidth\":0,\"cellHeight\":32,\"columns\":1,\"rows\":1,\"animations\":{}}"))
    }
  }

  @Test
  fun actionWithoutAnObserverSurvivesUntilConsumedExactlyOnce() {
    PetOverlayBridge.actionListener = null
    PetOverlayBridge.takePendingActions()
    val action = mapOf("type" to "openSession", "sessionId" to "session")
    PetOverlayBridge.action(action)
    assertEquals(listOf(action), PetOverlayBridge.takePendingActions())
    assertTrue(PetOverlayBridge.takePendingActions().isEmpty())
  }

  @Test
  fun observedActionIsNotReplayedFromPendingQueue() {
    PetOverlayBridge.takePendingActions()
    val received = mutableListOf<Map<String, String>>()
    PetOverlayBridge.actionListener = { received.add(it) }
    try {
      PetOverlayBridge.action(mapOf("type" to "open"))
      assertEquals(listOf(mapOf("type" to "open")), received)
      assertTrue(PetOverlayBridge.takePendingActions().isEmpty())
    } finally {
      PetOverlayBridge.actionListener = null
    }
  }

  @Test
  fun recycledActivityRowOpensAndDismissesTheCurrentSession() {
    val opened = mutableListOf<String?>()
    val dismissed = mutableListOf<PetItem>()
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), { opened.add(it) }, { dismissed.add(it) }, {}, { throw it })
    val initial = PetPayload.parse(payload(true))
    view.update(initial)
    val compact = compactRow(view)
    compact.getChildAt(1).performClick()
    val list = activityList(view)
    val row = list.adapter.getView(0, null, list) as LinearLayout
    assertTrue(row.getChildAt(0) is Button)
    row.getChildAt(1).performClick()
    assertEquals(listOf("session"), opened)
    val replacement = initial.items.single().copy(sessionId = "replacement", dismissKey = "replacement-dismiss")
    view.update(initial.copy(items = listOf(replacement)))
    val reused = list.adapter.getView(0, row, list) as LinearLayout
    assertSame(row, reused)
    reused.getChildAt(1).performClick()
    reused.getChildAt(0).performClick()
    assertEquals(listOf("session", "replacement"), opened)
    assertEquals(listOf(replacement), dismissed)
    view.detach()
  }

  @Test
  fun countIsCappedAt99AndExpandedActivityClosesWhenEmpty() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    val initial = PetPayload.parse(payload(true))
    view.update(initial.copy(items = List(120) { initial.items.single() }))
    val compact = compactRow(view)
    val toggle = compact.getChildAt(1) as Button
    assertEquals("99", toggle.text.toString())
    toggle.performClick()
    assertEquals("▾", toggle.text.toString())
    assertEquals(View.VISIBLE, activityList(view).visibility)
    view.update(initial.copy(items = emptyList()))
    assertEquals("0", toggle.text.toString())
    assertEquals(View.GONE, activityList(view).visibility)
    toggle.performClick()
    assertEquals(View.GONE, activityList(view).visibility)
    view.detach()
  }

  @Test
  fun collapsedOverlayOnlyOccupiesMascotAndTouchTarget() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view)
      val compact = compactRow(view)
      val mascot = compact.getChildAt(0)
      val toggle = compact.getChildAt(1)
      val touchTarget = (48 * view.resources.displayMetrics.density).toInt()
      assertEquals(mascot.measuredWidth + touchTarget, view.measuredWidth)
      assertEquals(mascot.measuredHeight, view.measuredHeight)
      assertTrue(toggle.measuredHeight >= touchTarget)
    } finally { view.detach() }
  }

  @Test
  fun activityPanelShrinksAfterItemsAreRemovedAndCollapseLeavesNoBlankPanel() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      val initial = PetPayload.parse(payload(true))
      view.update(initial)
      (compactRow(view).getChildAt(1) as Button).performClick()
      measureOverlay(view)
      val singleHeight = view.measuredHeight
      val singleWidth = view.measuredWidth
      val list = activityList(view)
      assertTrue(list.measuredHeight > 0)
      view.update(initial.copy(items = List(40) { initial.items.single().copy(sessionId = "session-$it") }))
      measureOverlay(view)
      assertTrue(view.measuredHeight > singleHeight)
      assertTrue(list.measuredHeight <= (240 * view.resources.displayMetrics.density).toInt())
      assertTrue(list.childCount < list.adapter.count)
      view.update(initial)
      measureOverlay(view)
      assertEquals(singleHeight, view.measuredHeight)
      assertEquals(singleWidth, view.measuredWidth)
      (compactRow(view).getChildAt(1) as Button).performClick()
      measureOverlay(view)
      assertEquals(View.GONE, list.visibility)
      assertEquals(compactRow(view).measuredHeight, view.measuredHeight)
    } finally { view.detach() }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun fixedWidthPanelEllipsizesLongTitlesWithoutGrowingRows() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      val initial = PetPayload.parse(payload(true))
      view.update(initial)
      (compactRow(view).getChildAt(1) as Button).performClick()
      measureOverlay(view)
      val shortWidth = view.measuredWidth
      val list = activityList(view)
      val shortHeight = list.measuredHeight
      assertEquals((240 * view.resources.displayMetrics.density).toInt().coerceAtMost(320), shortWidth)
      val longTitle = "检查这条独立提醒的中文标题，保持单行并在末尾省略。".repeat(8)
      view.update(initial.copy(items = listOf(
        initial.items.single().copy(title = longTitle, subtitle = "No extra subtitle row"),
        initial.items.single().copy(sessionId = "another-session", title = "另一条独立提醒")
      )))
      measureOverlay(view)
      assertEquals(shortWidth, view.measuredWidth)
      assertEquals(2, list.childCount)
      val longRow = list.getChildAt(0) as LinearLayout
      val independentRow = list.getChildAt(1) as LinearLayout
      assertEquals(shortHeight, longRow.height)
      assertEquals(shortHeight, independentRow.height)
      assertTrue(longRow.bottom <= independentRow.top)
      var title = (longRow.getChildAt(1) as TextView)
      assertEquals(longTitle, title.text.toString())
      assertEquals(1, title.layout.lineCount)
      assertTrue(title.layout.getEllipsisCount(0) > 0)
      measureOverlay(view, 220)
      assertEquals(220, view.measuredWidth)
      assertEquals(shortHeight, list.getChildAt(0).height)
      title = ((list.getChildAt(0) as LinearLayout).getChildAt(1) as TextView)
      assertEquals(1, title.layout.lineCount)
      assertTrue(title.layout.getEllipsisCount(0) > 0)
      view.update(initial.copy(items = emptyList()))
      measureOverlay(view)
      assertEquals(compactRow(view).measuredHeight, view.measuredHeight)
    } finally { view.detach() }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun compactButtonPaintsSmallerSurfaceWithoutShrinkingTouchTarget() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view)
      val toggle = compactRow(view).getChildAt(1) as Button
      assertTrue(toggle.width >= (48 * view.resources.displayMetrics.density).toInt())
      assertTrue(toggle.height >= (48 * view.resources.displayMetrics.density).toInt())
      val image = Bitmap.createBitmap(toggle.width, toggle.height, Bitmap.Config.ARGB_8888)
      try {
        toggle.draw(Canvas(image))
        assertEquals("The outer right touch area should be transparent", 0, Color.alpha(image.getPixel(image.width - 1, image.height / 2)))
        assertTrue("The badge should meet the pet-side edge", Color.alpha(image.getPixel(1, image.height / 2)) > 0)
        assertTrue(Color.alpha(image.getPixel(image.width / 3, image.height / 2)) > 0)
        assertEquals(
          "The badge surface must be smaller than the previous 32dp circle",
          0,
          Color.alpha(image.getPixel((28 * view.resources.displayMetrics.density).toInt(), image.height / 2))
        )
      } finally { image.recycle() }
    } finally { view.detach() }
  }

  @Test
  fun activityRowsCenterEdgeControlsWithTheTitleAndKeep48dpTouchTargets() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      val list = activityList(view)
      val row = list.adapter.getView(0, null, list) as LinearLayout
      val density = view.resources.displayMetrics.density
      val dismiss = row.getChildAt(0) as Button
      val title = row.getChildAt(1) as TextView
      val status = row.getChildAt(2) as ImageView
      assertEquals(Gravity.CENTER_VERTICAL, dismiss.gravity and Gravity.VERTICAL_GRAVITY_MASK)
      assertEquals(Gravity.CENTER_HORIZONTAL, dismiss.gravity and Gravity.HORIZONTAL_GRAVITY_MASK)
      assertFalse(dismiss.includeFontPadding)
      assertEquals(0, dismiss.paddingTop)
      assertEquals(0, dismiss.paddingBottom)
      assertEquals(0, dismiss.paddingRight)
      assertEquals((26 * density).toInt(), dismiss.layoutParams.width)
      assertFalse(title.includeFontPadding)
      assertEquals(Gravity.CENTER_VERTICAL, title.gravity and Gravity.VERTICAL_GRAVITY_MASK)
      assertEquals(0, title.paddingTop)
      assertEquals(0, title.paddingBottom)
      assertEquals((4 * density).toInt(), title.paddingLeft)
      assertEquals((4 * density).toInt(), title.paddingRight)
      val statusParams = status.layoutParams as LinearLayout.LayoutParams
      assertEquals((20 * density).toInt(), statusParams.width)
      assertEquals((20 * density).toInt(), statusParams.height)
      assertEquals(Gravity.CENTER_VERTICAL, statusParams.gravity)
      assertTrue(row.minimumHeight >= (40 * density).toInt())
    } finally { view.detach() }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun activityRowsShowDistinctIconsWithSemanticColorsAndOnlyAccessibleStatusWords() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      val colors = mapOf("waiting" to "#FF9500", "failed" to "#FF3B30", "review" to "#34C759", "running" to "#34C759")
      val raw = JSONObject(payload(true))
      raw.getJSONObject("colors").put("statuses", JSONObject(colors))
      val initial = PetPayload.parse(raw.toString())
      val labels = initial.labels.copy(statuses = colors.keys.associateWith { "Localized $it" })
      view.update(initial.copy(labels = labels))
      compactRow(view).getChildAt(1).performClick()
      val list = activityList(view)
      var row: LinearLayout? = null
      val silhouettes = mutableSetOf<List<Int>>()
      for ((status, color) in colors) {
        view.update(initial.copy(labels = labels, items = listOf(initial.items.single().copy(status = status))))
        row = list.adapter.getView(0, row, list) as LinearLayout
        val title = row.getChildAt(1) as TextView
        assertEquals("Title", title.text.toString())
        val icon = row.getChildAt(2) as ImageView
        assertNotNull(icon.drawable)
        assertEquals(Color.parseColor(color), icon.imageTintList!!.defaultColor)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, icon.importantForAccessibility)
        assertTrue(title.contentDescription.contains("Localized $status"))
        for (index in 0 until row.childCount) {
          val child = row.getChildAt(index)
          if (child is TextView) assertFalse(child.text.contains("Localized"))
        }
        // Compare ink, not resource names: review's check-circle must differ from running's circle even with the same green.
        val image = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        try {
          icon.drawable.setBounds(0, 0, 64, 64)
          icon.drawable.draw(Canvas(image))
          silhouettes.add((0 until 64 * 64).map { Color.alpha(image.getPixel(it % 64, it / 64)) })
        } finally { image.recycle() }
      }
      assertEquals(colors.size, silhouettes.size)
      view.update(initial.copy(connected = false))
      row = list.adapter.getView(0, row, list) as LinearLayout
      assertTrue((row.getChildAt(1) as TextView).contentDescription.contains("Offline"))
      assertEquals(initial.colors.secondary, (row.getChildAt(2) as ImageView).imageTintList!!.defaultColor)
      val summary = (0 until view.childCount).map { view.getChildAt(it) }.filterIsInstance<TextView>().single()
      assertEquals(View.VISIBLE, summary.visibility)
      assertEquals("Offline", summary.contentDescription.toString())
      assertFalse(summary.text.contains("Offline"))
      // Built-in callers without the additive colors still work in the same APK.
      view.update(PetPayload.parse(payload(true)).copy(items = listOf(initial.items.single().copy(status = "running"))))
      row = list.adapter.getView(0, row, list) as LinearLayout
      assertEquals(initial.colors.accent, (row.getChildAt(2) as ImageView).imageTintList!!.defaultColor)
    } finally { view.detach() }
  }

  @Test
  @Config(shadows = [ShadowArguments::class])
  fun foregroundLifecycleHidesWindowWithoutStoppingRuntimeAndBackgroundRestoresIt() {
    ShadowSettings.setCanDrawOverlays(true)
    val started = mutableListOf<Int>()
    val registry = object : AppRegistry {
      override fun runApplication(appKey: String, appParameters: WritableMap) { fail("Must not create an application") }
      override fun unmountApplicationComponentAtRootTag(rootNodeTag: Int) { fail("Must not unmount the application") }
      override fun startHeadlessTask(taskId: Int, taskKey: String, data: WritableMap) { started.add(taskId) }
    }
    val runtime = object : BridgeReactContext(RuntimeEnvironment.getApplication()) {
      override fun hasActiveReactInstance() = true
      override fun <ModuleType : JavaScriptModule> getJSModule(jsInterface: Class<ModuleType>): ModuleType = jsInterface.cast(registry)
    }
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    val service = controller.get()
    val windows = Shadow.extract<ShadowWindowManagerImpl>(service.getSystemService(Context.WINDOW_SERVICE))
    val listeners = HappierPetOverlayModule().definition().eventListeners
    try {
      PetOverlayBridge.stateListener = null
      PetOverlayBridge.reactContext = runtime
      PetOverlayBridge.pendingPayload = PetPayload.parse(payload(true))
      service.onStartCommand(Intent(service, PetOverlayService::class.java), 0, 1)
      assertTrue(PetOverlayBridge.running)
      assertTrue("Starting in the app foreground must not display an overlay", windows.views.isEmpty())
      val foreground = listeners[EventName.ACTIVITY_ENTERS_FOREGROUND] as BasicEventListener
      val background = listeners[EventName.ACTIVITY_ENTERS_BACKGROUND] as BasicEventListener
      background.call()
      assertEquals(1, windows.views.size)
      val overlay = windows.views.single() as PetOverlayView
      (compactRow(overlay).getChildAt(1) as Button).performClick()
      foreground.call()
      foreground.call()
      assertTrue(windows.views.isEmpty())
      assertTrue(PetOverlayBridge.running)
      assertTrue(HeadlessJsTaskContext.getInstance(runtime).isTaskRunning(started.single()))
      val changed = PetPayload.parse(payload(true))
      service.update(changed.copy(items = listOf(changed.items.single().copy(title = "Updated while hidden"))))
      background.call()
      assertEquals(listOf(overlay), windows.views)
      val restoredList = activityList(overlay)
      assertEquals(View.VISIBLE, restoredList.visibility)
      assertEquals("Updated while hidden", (restoredList.adapter.getItem(0) as PetItem).title)
      foreground.call()
      service.update(changed.copy(items = emptyList()))
      background.call()
      background.call()
      assertEquals(listOf(overlay), windows.views)
      assertEquals(View.GONE, activityList(overlay).visibility)
      foreground.call()
      service.shutdown()
      background.call()
      assertTrue(windows.views.isEmpty())
      assertFalse(PetOverlayBridge.running)
      assertFalse(HeadlessJsTaskContext.getInstance(runtime).hasActiveTasks())
    } finally {
      controller.destroy()
      ShadowSettings.setCanDrawOverlays(false)
    }
  }

  @Test
  fun systemRemovedWindowCanStillBeReleasedWithoutInterruptingCleanup() {
    val context = RuntimeEnvironment.getApplication()
    val view = PetOverlayView(context, {}, {}, {}, { throw it })
    view.attach()
    context.getSystemService(WindowManager::class.java).removeViewImmediate(view)
    view.detach()
    view.detach()
  }

  @Test
  @Config(shadows = [ShadowArguments::class])
  fun leavingAppBeforeServiceCreationStillShowsOverlayWhenStartupCompletes() {
    ShadowSettings.setCanDrawOverlays(true)
    PetOverlayBridge.stateListener = null
    val listeners = HappierPetOverlayModule().definition().eventListeners
    val foreground = listeners[EventName.ACTIVITY_ENTERS_FOREGROUND] as BasicEventListener
    val background = listeners[EventName.ACTIVITY_ENTERS_BACKGROUND] as BasicEventListener
    foreground.call()
    background.call()
    val registry = object : AppRegistry {
      override fun runApplication(appKey: String, appParameters: WritableMap) { fail("Must not create an application") }
      override fun unmountApplicationComponentAtRootTag(rootNodeTag: Int) { fail("Must not unmount the application") }
      override fun startHeadlessTask(taskId: Int, taskKey: String, data: WritableMap) { }
    }
    val runtime = object : BridgeReactContext(RuntimeEnvironment.getApplication()) {
      override fun hasActiveReactInstance() = true
      override fun <ModuleType : JavaScriptModule> getJSModule(jsInterface: Class<ModuleType>): ModuleType = jsInterface.cast(registry)
    }
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    try {
      val service = controller.get()
      val windows = Shadow.extract<ShadowWindowManagerImpl>(service.getSystemService(Context.WINDOW_SERVICE))
      PetOverlayBridge.reactContext = runtime
      PetOverlayBridge.pendingPayload = PetPayload.parse(payload(true))
      service.onStartCommand(Intent(service, PetOverlayService::class.java), 0, 1)
      assertTrue(PetOverlayBridge.running)
      assertEquals("The background event must survive asynchronous service creation", 1, windows.views.size)
      foreground.call()
      assertTrue(windows.views.isEmpty())
      background.call()
      assertEquals(1, windows.views.size)
    } finally {
      controller.destroy()
      foreground.call()
      ShadowSettings.setCanDrawOverlays(false)
    }
  }

  private fun compactRow(view: PetOverlayView): LinearLayout =
    (0 until view.childCount).map { view.getChildAt(it) }.filterIsInstance<LinearLayout>()
      .single { it.childCount > 0 && (it.getChildAt(0) is PetSpriteView ||
        ((it.getChildAt(0) as? FrameLayout)?.getChildAt(0) is PetSpriteView)) }

  private fun activityList(view: PetOverlayView): ListView =
    (0 until view.childCount).map { view.getChildAt(it) }.filterIsInstance<ListView>().single()

  @Test
  fun expandedTraySitsAbovePetAndBadgeHugsItsTopRight() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      compactRow(view).getChildAt(1).performClick()
      measureOverlay(view)
      val compact = compactRow(view)
      val mascot = compact.getChildAt(0)
      val badge = compact.getChildAt(1)
      assertTrue(activityList(view).bottom <= compact.top)
      assertEquals(view.width, compact.right)
      assertEquals(mascot.right, badge.left)
      assertEquals(0, badge.top)
    } finally { view.detach() }
  }

  @Test
  fun resizingTrayKeepsPetCornerStationaryWhenItFitsOnScreen() {
    RuntimeEnvironment.setQualifiers("w600dp-h900dp")
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view, 600)
      view.attach()
      val params = view.layoutParams as WindowManager.LayoutParams
      params.x = 300
      params.y = 400
      val cornerX = params.x + view.width
      val cornerY = params.y + view.height
      compactRow(view).getChildAt(1).performClick()
      measureOverlay(view, 600)
      assertEquals(cornerX, params.x + view.width)
      assertEquals(cornerY, params.y + view.height)
      compactRow(view).getChildAt(1).performClick()
      measureOverlay(view, 600)
      assertEquals(cornerX, params.x + view.width)
      assertEquals(cornerY, params.y + view.height)
    } finally { view.detach() }
  }

  @Test
  fun exactWindowRemeasureKeepsMascotSizeInsteadOfOscillating() {
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view)
      val width = view.measuredWidth
      val height = view.measuredHeight
      val mascot = compactRow(view).getChildAt(0)
      val mascotWidth = mascot.measuredWidth
      val mascotHeight = mascot.measuredHeight
      repeat(3) {
        view.forceLayout()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)
        assertEquals(mascotWidth, mascot.measuredWidth)
        assertEquals(mascotHeight, mascot.measuredHeight)
        assertEquals(width, view.measuredWidth)
        assertEquals(height, view.measuredHeight)
      }
    } finally { view.detach() }
  }

  @Test
  fun unchangedLayoutDoesNotRepublishWindowParameters() {
    val application = RuntimeEnvironment.getApplication()
    val realWindows = application.getSystemService(WindowManager::class.java)
    var updates = 0
    val windows = Proxy.newProxyInstance(WindowManager::class.java.classLoader, arrayOf(WindowManager::class.java)) { _, method, arguments ->
      if (method.name == "updateViewLayout") updates++
      method.invoke(realWindows, *(arguments ?: emptyArray()))
    } as WindowManager
    val context = object : ContextWrapper(application) {
      override fun getSystemService(name: String): Any? = if (name == Context.WINDOW_SERVICE) windows else super.getSystemService(name)
    }
    val view = PetOverlayView(context, {}, {}, {}, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view)
      view.attach()
      val before = updates
      repeat(3) {
        view.forceLayout()
        measureOverlay(view)
      }
      assertEquals("Equal layouts must not trigger another WindowManager relayout", before, updates)
    } finally { view.detach() }
  }

  @Test
  fun badgeClosesSpriteMarginWithoutShrinkingPetOrOverlappingTouchTargets() {
    val opened = mutableListOf<String?>()
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), { opened.add(it) }, {}, {}, { throw it })
    try {
      val initial = PetPayload.parse(payload(true))
      for (scale in listOf(1f, 2f)) {
        view.update(initial.copy(sizeScale = scale))
        measureOverlay(view)
        val compact = compactRow(view)
        val pet = compact.getChildAt(0)
        val sprite = if (pet is FrameLayout) pet.getChildAt(0) else pet
        val badge = compact.getChildAt(1)
        val expectedSize = (80 * scale * view.resources.displayMetrics.density).toInt()
        assertEquals("Do not shrink the rendered pet to close the gap", expectedSize, sprite.measuredWidth)
        assertEquals(expectedSize, sprite.measuredHeight)
        assertTrue("Use the sprite's transparent margin rather than placing the badge beyond the whole image", badge.left <= sprite.measuredWidth - (16 * view.resources.displayMetrics.density).toInt())
        assertTrue(pet.measuredWidth >= (48 * view.resources.displayMetrics.density).toInt())
        assertTrue(badge.measuredWidth >= (48 * view.resources.displayMetrics.density).toInt())
        assertTrue("The pet and badge touch targets must not overlap", pet.right <= badge.left)
        pet.performClick()
      }
      assertEquals(listOf(null, null), opened)
    } finally { view.detach() }
  }

  @Test
  fun petDragMovesBadgeTogetherWithoutActivatingItAndMenuActionsStillWork() {
    RuntimeEnvironment.setQualifiers("w600dp-h900dp")
    val opened = mutableListOf<String?>()
    var stops = 0
    val view = PetOverlayView(RuntimeEnvironment.getApplication(), { opened.add(it) }, {}, { stops++ }, { throw it })
    try {
      view.update(PetPayload.parse(payload(true)))
      measureOverlay(view, 600)
      view.attach()
      val compact = compactRow(view)
      val pet = compact.getChildAt(0)
      val badge = compact.getChildAt(1) as Button
      val params = view.layoutParams as WindowManager.LayoutParams
      val petX = params.x + compact.left + pet.left
      val badgeX = params.x + compact.left + badge.left
      val badgeY = params.y + compact.top + badge.top
      val relativeX = badgeX - petX
      fun touch(action: Int, x: Float, y: Float, time: Long) {
        val event = MotionEvent.obtain(0, time, action, x, y, 0)
        try { pet.dispatchTouchEvent(event) } finally { event.recycle() }
      }
      touch(MotionEvent.ACTION_DOWN, 10f, 10f, 0)
      touch(MotionEvent.ACTION_MOVE, 50f, 40f, 10)
      touch(MotionEvent.ACTION_UP, 50f, 40f, 20)
      assertEquals(badgeX + 40, params.x + compact.left + badge.left)
      assertEquals(badgeY + 30, params.y + compact.top + badge.top)
      assertEquals(relativeX, badge.left - pet.left)
      assertEquals(View.GONE, activityList(view).visibility)
      assertTrue(opened.isEmpty())
      pet.performClick()
      assertEquals(listOf(null), opened)
      badge.performClick()
      assertEquals(View.VISIBLE, activityList(view).visibility)
      badge.performClick()
      assertEquals(View.GONE, activityList(view).visibility)
      pet.performLongClick()
      val menu = (0 until view.childCount).map { view.getChildAt(it) }.filterIsInstance<LinearLayout>()
        .single { it !== compact }
      assertEquals(View.VISIBLE, menu.visibility)
      menu.getChildAt(0).performClick()
      assertEquals(View.GONE, menu.visibility)
      badge.performLongClick()
      menu.getChildAt(1).performClick()
      assertEquals(1, stops)
    } finally { view.detach() }
  }

  private fun measureOverlay(view: PetOverlayView, availableWidth: Int = 320) {
    view.measure(View.MeasureSpec.makeMeasureSpec(availableWidth, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.AT_MOST))
    view.layout(0, 0, view.measuredWidth, view.measuredHeight)
  }

  @Test
  fun systemRestartWithoutPayloadDoesNotRestartOverlay() {
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    assertEquals(Service.START_NOT_STICKY, controller.get().onStartCommand(null, 0, 1))
    assertFalse(PetOverlayBridge.running)
    controller.destroy()
  }

  @Test
  fun notificationStopAndTaskRemovalLeaveNoRunningState() {
    val controller = Robolectric.buildService(PetOverlayService::class.java).create()
    val service = controller.get()
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(Intent().setAction(PetOverlayService.STOP), 0, 1))
    service.onTaskRemoved(Intent())
    controller.destroy()
    assertFalse(PetOverlayBridge.running)
    assertNull(PetOverlayBridge.service)
  }

  private fun payload(connected: Boolean) = """{
    "state":"working","connected":$connected,"spriteUri":null,"sprite":null,
    "reducedMotion":true,"sizeScale":1,
    "items":[{"sessionId":"session","dismissKey":"dismiss","title":"Title","status":"working"}],
    "labels":{"title":"Pet","stop":"Stop","activity":"Activity","disconnected":"Offline","open":"Open","close":"Close","statuses":{"working":"Working"}},
    "colors":{"background":"#FFFFFF","text":"#000000","secondary":"#555555","accent":"#123456"}
  }"""

  private class RecordingPromise : Promise {
    var resolutions = 0
    var failure: Throwable? = null
    override fun resolve(value: Any?) { resolutions++ }
    override fun reject(code: String, message: String?, cause: Throwable?) { failure = cause }
  }

  private class InlineExecutor : AbstractExecutorService() {
    private var stopped = false
    override fun execute(command: Runnable) { check(!stopped); command.run() }
    override fun shutdown() { stopped = true }
    override fun shutdownNow(): MutableList<Runnable> { stopped = true; return mutableListOf() }
    override fun isShutdown() = stopped
    override fun isTerminated() = stopped
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = stopped
  }

  @Implements(value = Arguments::class, isInAndroidSdk = false)
  class ShadowArguments {
    companion object {
      @JvmStatic
      @Implementation
      fun createMap(): WritableMap = JavaOnlyMap()
    }
  }
}
