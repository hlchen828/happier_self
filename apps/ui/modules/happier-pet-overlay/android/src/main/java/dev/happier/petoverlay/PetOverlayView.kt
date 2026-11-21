package dev.happier.petoverlay

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.PixelFormat
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.text.TextUtils
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.ImageView
import kotlin.math.abs
import kotlin.math.max

internal class PetOverlayView(
  context: Context,
  private val open: (String?) -> Unit,
  private val dismiss: (PetItem) -> Unit,
  private val stop: () -> Unit,
  onSpriteError: (Throwable) -> Unit
) : LinearLayout(context) {
  private val windowManager = context.getSystemService(WindowManager::class.java)
  private val position = WindowManager.LayoutParams(
    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
    if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT
  ).apply { gravity = Gravity.TOP or Gravity.LEFT; x = dp(16); y = dp(96) }
  private val mascot = PetSpriteView(context, onSpriteError)
  private val petTouchTarget = object : FrameLayout(context) {
    override fun getAccessibilityClassName(): CharSequence = Button::class.java.name
  }
  private val compact = LinearLayout(context)
  private val toggle = Button(context)
  private val summary = TextView(context)
  private val list = ListView(context)
  private val menu = LinearLayout(context)
  private val closeMenu = Button(context)
  private val stopButton = Button(context)
  private var payload: PetPayload? = null
  private var expanded = false
  private var screenInteractive = true
  private var attached = false
  private var downX = 0f
  private var downY = 0f
  private var startX = 0
  private var startY = 0
  private var dragging = false
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private val rows = Rows()
  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(event: MotionEvent) = true
    override fun onSingleTapUp(event: MotionEvent): Boolean {
      petTouchTarget.performClick()
      return true
    }
    override fun onLongPress(event: MotionEvent) {
      if (!dragging) petTouchTarget.performLongClick()
    }
  })

  init {
    orientation = VERTICAL
    compact.gravity = Gravity.TOP
    compact.clipChildren = false
    petTouchTarget.clipChildren = false
    petTouchTarget.addView(mascot, FrameLayout.LayoutParams(dp(80), dp(80)))
    mascot.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    compact.addView(petTouchTarget, LayoutParams(dp(60), dp(80)))
    compact.addView(toggle, LayoutParams(dp(48), dp(48)))
    list.adapter = rows
    list.divider = ColorDrawable(Color.TRANSPARENT)
    list.dividerHeight = dp(4)
    addView(list, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(summary, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    menu.orientation = HORIZONTAL
    menu.addView(closeMenu, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    menu.addView(stopButton, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    addView(menu, LayoutParams(dp(280), LayoutParams.WRAP_CONTENT))
    addView(compact, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.RIGHT })
    closeMenu.setOnClickListener { menu.visibility = GONE; updateVisibility() }
    stopButton.setOnClickListener { stop() }
    toggle.setOnClickListener { expanded = !expanded; updateVisibility() }
    toggle.setOnLongClickListener { menu.visibility = VISIBLE; updateVisibility(); true }
    petTouchTarget.setOnClickListener { open(null) }
    petTouchTarget.setOnLongClickListener { menu.visibility = VISIBLE; updateVisibility(); true }
    petTouchTarget.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX; downY = event.rawY; startX = position.x; startY = position.y; dragging = false
        }
        MotionEvent.ACTION_MOVE -> {
          if (abs(event.rawX - downX) > slop || abs(event.rawY - downY) > slop) dragging = true
          if (dragging) {
            position.x = startX + (event.rawX - downX).toInt()
            position.y = startY + (event.rawY - downY).toInt()
            clampPosition(true)
          }
        }
      }
      if (!dragging) gestures.onTouchEvent(event)
      else {
        val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
        gestures.onTouchEvent(cancel)
        cancel.recycle()
      }
      true
    }
    list.visibility = GONE
    menu.visibility = GONE
    summary.visibility = GONE
    toggle.minimumWidth = dp(48)
    toggle.minimumHeight = dp(48)
    toggle.setPadding(0, 0, dp(22), 0)
    toggle.gravity = Gravity.CENTER
    toggle.includeFontPadding = false
    toggle.textSize = 12f
    toggle.stateListAnimator = null
    toggle.elevation = 0f
    closeMenu.minimumHeight = dp(48)
    stopButton.minimumHeight = dp(48)
    addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
      val widthDelta = (oldRight - oldLeft) - (right - left)
      val heightDelta = (oldBottom - oldTop) - (bottom - top)
      val resized = oldRight > oldLeft && oldBottom > oldTop && (widthDelta != 0 || heightDelta != 0)
      if (attached && resized) {
        // Keep the pet's bottom-right anchor when its tray grows upward or collapses.
        position.x += widthDelta
        position.y += heightDelta
      }
      clampPosition(resized)
    }
  }

  fun attach() {
    if (attached) return
    windowManager.addView(this, position)
    attached = true
    updateVisibility()
  }

  fun hide() {
    if (!attached) return
    attached = false
    mascot.setAnimating(false)
    // Android may already have removed the window after an overlay permission change.
    try { windowManager.removeViewImmediate(this) } catch (error: IllegalArgumentException) { }
  }

  fun detach() {
    mascot.release()
    hide()
  }

  fun update(next: PetPayload) {
    val previous = payload
    payload = next
    petTouchTarget.contentDescription = "${next.labels.open}: ${next.labels.title}"
    mascot.update(next)
    summary.text = "⊘"
    summary.contentDescription = next.summary
    summary.setTextColor(next.colors.secondary)
    toggle.setTextColor(next.colors.accent)
    // Keep the 48dp touch target while painting a smaller 26dp badge that still hugs the pet edge.
    toggle.background = InsetDrawable(buttonSurface(next, 13), 0, dp(11), dp(22), dp(11))
    toggle.setPadding(0, 0, dp(22), 0)
    petTouchTarget.foreground = RippleDrawable(ColorStateList.valueOf(next.colors.accent), null, null)
    summary.background = GradientDrawable().apply { setColor(next.colors.background); cornerRadius = dp(12).toFloat() }
    closeMenu.text = next.labels.close
    stopButton.text = next.labels.stop
    closeMenu.setTextColor(next.colors.text)
    stopButton.setTextColor(next.colors.accent)
    closeMenu.background = buttonSurface(next)
    stopButton.background = buttonSurface(next)
    list.background = null
    menu.background = GradientDrawable().apply { setColor(next.colors.background); cornerRadius = dp(12).toFloat() }
    if (expanded && (previous == null || previous.items != next.items || previous.labels != next.labels || previous.colors != next.colors || previous.connected != next.connected)) rows.notifyDataSetChanged()
    updateVisibility()
  }

  fun setScreenInteractive(interactive: Boolean) {
    screenInteractive = interactive
    mascot.setAnimating(attached && interactive && !expanded && menu.visibility != VISIBLE)
  }

  private fun updateVisibility() {
    val labels = payload?.labels
    val count = payload?.items?.size ?: 0
    if (count == 0) expanded = false
    toggle.text = if (expanded) "▾" else count.coerceAtMost(99).toString()
    toggle.contentDescription = "${if (expanded) labels?.close else labels?.activity}: ${payload?.items?.size ?: 0}"
    toggle.isSelected = expanded
    if (expanded && list.visibility != VISIBLE) rows.notifyDataSetChanged()
    list.visibility = if (expanded) VISIBLE else GONE
    summary.visibility = if (payload?.connected == false) VISIBLE else GONE
    mascot.setAnimating(attached && screenInteractive && !expanded && menu.visibility != VISIBLE)
    requestLayout()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val screen = resources.displayMetrics
    val availableWidth = if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.UNSPECIFIED) screen.widthPixels
      else minOf(screen.widthPixels, MeasureSpec.getSize(widthMeasureSpec))
    val availableHeight = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) screen.heightPixels
      else minOf(screen.heightPixels, MeasureSpec.getSize(heightMeasureSpec))
    val panelWidthLimit = minOf(dp(240), availableWidth)
    val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    val boundedWidth = MeasureSpec.makeMeasureSpec(panelWidthLimit, MeasureSpec.AT_MOST)
    val preferredMascotSize = max(dp(48), dp(80 * (payload?.sizeScale ?: 1f)))
    val renderedSize = minOf(preferredMascotSize, max(0, availableWidth - dp(48) + dp(20)), max(0, screen.heightPixels - dp(96)))
    mascot.layoutParams.width = renderedSize
    mascot.layoutParams.height = renderedSize
    // Let decorative pixels use the transparent margin without overlapping the two touch targets.
    petTouchTarget.layoutParams.width = minOf(max(dp(48), renderedSize - dp(20)), max(0, availableWidth - dp(48)))
    petTouchTarget.layoutParams.height = renderedSize
    compact.measure(MeasureSpec.makeMeasureSpec(availableWidth, MeasureSpec.AT_MOST), unspecified)
    summary.maxWidth = panelWidthLimit
    if (summary.visibility != GONE) summary.measure(boundedWidth, unspecified)
    if (menu.visibility != GONE) {
      menu.layoutParams.width = panelWidthLimit
      menu.measure(MeasureSpec.makeMeasureSpec(panelWidthLimit, MeasureSpec.EXACTLY), unspecified)
    }
    if (list.visibility != GONE) {
      val heightLimit = minOf(dp(240), max(0, availableHeight - compact.measuredHeight
        - (if (summary.visibility != GONE) summary.measuredHeight else 0)
        - (if (menu.visibility != GONE) menu.measuredHeight else 0)))
      var panelHeight = 0
      var row: View? = null
      var index = 0
      // A fixed-width, single-line panel still measures only its first viewport.
      while (index < rows.count && panelHeight < heightLimit) {
        row = rows.getView(index++, row, list)
        row.measure(MeasureSpec.makeMeasureSpec(panelWidthLimit, MeasureSpec.EXACTLY), unspecified)
        panelHeight += row.measuredHeight + if (index > 1) list.dividerHeight else 0
      }
      list.layoutParams.width = panelWidthLimit
      list.layoutParams.height = minOf(heightLimit, panelHeight)
    }
    super.onMeasure(
      if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.EXACTLY) widthMeasureSpec
        else MeasureSpec.makeMeasureSpec(availableWidth, MeasureSpec.AT_MOST),
      if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) heightMeasureSpec
        else MeasureSpec.makeMeasureSpec(availableHeight, MeasureSpec.AT_MOST)
    )
  }

  private fun clampPosition(updateRequired: Boolean = false) {
    if (!attached) return
    val bounds = if (Build.VERSION.SDK_INT >= 30) windowManager.currentWindowMetrics.bounds else null
    val screenWidth = bounds?.width() ?: resources.displayMetrics.widthPixels
    val screenHeight = bounds?.height() ?: resources.displayMetrics.heightPixels
    val x = position.x.coerceIn(0, max(0, screenWidth - width))
    val y = position.y.coerceIn(0, max(0, screenHeight - height))
    val clamped = x != position.x || y != position.y
    position.x = x
    position.y = y
    if (!updateRequired && !clamped) return
    try { windowManager.updateViewLayout(this, position) } catch (error: RuntimeException) { stop() }
  }

  private fun dp(value: Int) = dp(value.toFloat())
  private fun dp(value: Float) = (value * resources.displayMetrics.density).toInt()
  private fun buttonSurface(current: PetPayload, radius: Int = 12) = RippleDrawable(
    ColorStateList.valueOf(current.colors.accent),
    GradientDrawable().apply { setColor(current.colors.background); cornerRadius = dp(radius).toFloat() },
    null
  )

  private fun compactButtonSurface(current: PetPayload) = InsetDrawable(buttonSurface(current), dp(8))

  private inner class Rows : BaseAdapter() {
    override fun getCount() = payload?.items?.size ?: 0
    override fun getItem(index: Int) = requireNotNull(payload).items[index]
    override fun getItemId(index: Int) = index.toLong()
    override fun getView(index: Int, recycled: View?, parent: ViewGroup): View {
      val row = recycled as? LinearLayout ?: LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(40)
        addView(Button(context).apply {
          minimumWidth = 0
          minimumHeight = 0
          text = "×"
          textSize = 18f
          // A compact visual button keeps the symbol at the row edge; the row remains 48dp tall.
          gravity = Gravity.CENTER
          includeFontPadding = false
          setPadding(0, 0, 0, 0)
          stateListAnimator = null
          elevation = 0f
        }, LayoutParams(dp(26), dp(40)))
        addView(TextView(context).apply {
          setPadding(dp(4), 0, dp(4), 0)
          gravity = Gravity.CENTER_VERTICAL
          includeFontPadding = false
          setSingleLine(true)
          ellipsize = TextUtils.TruncateAt.END
        }, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        addView(ImageView(context).apply {
          scaleType = ImageView.ScaleType.CENTER_INSIDE
          setPadding(0, 0, 0, 0)
          importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LayoutParams(dp(20), dp(20)).apply { gravity = Gravity.CENTER_VERTICAL })
      }
      val current = requireNotNull(payload)
      val item = getItem(index)
      val text = row.getChildAt(1) as TextView
      text.text = item.title
      text.setTextColor(current.colors.text)
      row.background = buttonSurface(current, 24)
      text.background = null
      text.contentDescription = "${current.labels.open}: ${item.title}, ${current.status(item)}"
      text.setOnClickListener { open(item.sessionId) }
      row.setOnClickListener { open(item.sessionId) }
      val status = row.getChildAt(2) as ImageView
      status.setImageResource(if (!current.connected) R.drawable.pet_status_disconnected else when (item.status) {
        "waiting" -> R.drawable.pet_status_clock
        "failed" -> R.drawable.pet_status_warning
        "review" -> R.drawable.pet_status_check_circle
        else -> R.drawable.pet_status_circle
      })
      status.imageTintList = ColorStateList.valueOf(
        if (current.connected) current.colors.statuses[item.status] ?: current.colors.accent else current.colors.secondary
      )
      val dismissButton = row.getChildAt(0) as Button
      dismissButton.setTextColor(current.colors.secondary)
      dismissButton.background = compactButtonSurface(current)
      dismissButton.setPadding(0, 0, 0, 0)
      dismissButton.contentDescription = "${current.labels.close}: ${item.title}"
      dismissButton.setOnClickListener { dismiss(item) }
      return row
    }
  }
}
