package dev.happier.petoverlay

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Choreographer
import android.view.View
import android.widget.Button
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import kotlin.math.min
import kotlin.math.ceil

internal class PetSpriteView(
  context: Context,
  private val onSpriteError: (Throwable) -> Unit,
  private val decoder: ExecutorService = Executors.newSingleThreadExecutor()
) : View(context), Choreographer.FrameCallback {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val source = Rect()
  private val destination = RectF()
  private val main = Handler(Looper.getMainLooper())
  private var bitmap: Bitmap? = null
  private var payload: PetPayload? = null
  private var animation: PetAnimation? = null
  private var frame = 0
  private var startedAt = 0L
  private var animating = true
  private var scheduled = false
  private var released = false
  private var decodeVersion = 0

  override fun getAccessibilityClassName(): CharSequence = Button::class.java.name

  fun update(next: PetPayload) {
    val previous = payload
    payload = next
    val nextAnimation = next.sprite?.animations?.let { animations ->
      if (next.connected) animations[next.state] ?: animations["idle"] else animations["idle"]
    }
    if (animation != nextAnimation) {
      animation = nextAnimation
      frame = 0
      startedAt = 0L
    }
    if (previous == null || previous.spriteUri != next.spriteUri || previous.sprite != next.sprite || previous.sizeScale != next.sizeScale) {
      decode(next)
    }
    refreshScheduling()
    invalidate()
  }

  fun setAnimating(enabled: Boolean) {
    if (animating == enabled) return
    animating = enabled
    startedAt = 0L
    refreshScheduling()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    refreshScheduling()
  }

  override fun onDetachedFromWindow() {
    unschedule()
    super.onDetachedFromWindow()
  }

  private fun refreshScheduling(delayMs: Long = 0) {
    val shouldAnimate = !released && isAttachedToWindow && animating && payload?.reducedMotion == false && bitmap != null && (animation?.frames ?: 0) > 1
    if (shouldAnimate && !scheduled) {
      scheduled = true
      Choreographer.getInstance().postFrameCallbackDelayed(this, delayMs)
    } else if (!shouldAnimate) {
      unschedule()
      frame = 0
      invalidate()
    }
  }

  private fun unschedule() {
    if (scheduled) Choreographer.getInstance().removeFrameCallback(this)
    scheduled = false
  }

  override fun doFrame(frameTimeNanos: Long) {
    scheduled = false
    val current = animation ?: return
    if (startedAt == 0L) startedAt = frameTimeNanos
    val elapsedMs = (frameTimeNanos - startedAt) / 1_000_000.0
    val nextFrame = current.frameAt(elapsedMs)
    if (nextFrame != frame) {
      frame = nextFrame
      invalidate()
    }
    refreshScheduling(ceil(current.untilNextFrame(elapsedMs)).toLong().coerceAtLeast(1))
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val current = payload ?: return
    val image = bitmap
    val sprite = current.sprite
    if (image == null || sprite == null) {
      paint.color = current.colors.accent
      canvas.drawCircle(width / 2f, height / 2f, min(width, height) / 4f, paint)
      return
    }
    val cellWidth = image.width / sprite.columns
    val cellHeight = image.height / sprite.rows
    val row = animation?.row ?: 0
    source.set(frame * cellWidth, row * cellHeight, (frame + 1) * cellWidth, (row + 1) * cellHeight)
    val scale = min(width.toFloat() / cellWidth, height.toFloat() / cellHeight)
    val drawWidth = cellWidth * scale
    val drawHeight = cellHeight * scale
    destination.set((width - drawWidth) / 2, (height - drawHeight) / 2, (width + drawWidth) / 2, (height + drawHeight) / 2)
    canvas.drawBitmap(image, source, destination, paint)
  }

  private fun decode(next: PetPayload) {
    val version = ++decodeVersion
    bitmap?.recycle()
    bitmap = null
    val sprite = next.sprite
    val raw = next.spriteUri
    if (sprite == null && raw == null) return
    if (sprite == null || raw == null) {
      main.post {
        if (!released && version == decodeVersion) onSpriteError(IllegalArgumentException("Pet sprite image and atlas metadata are both required"))
      }
      return
    }
    val target = (80 * next.sizeScale * resources.displayMetrics.density).toInt().coerceAtLeast(1)
    decoder.execute {
      val image = decodeImage(raw, sprite, target, context)
      main.post {
        if (released || version != decodeVersion) image?.recycle()
        else if (image == null) onSpriteError(IllegalStateException("Unable to decode the pet sprite atlas"))
        else {
          bitmap = image
          refreshScheduling()
          invalidate()
        }
      }
    }
  }

  companion object {
    internal fun decodeImage(raw: String, sprite: PetSprite, target: Int, context: Context? = null): Bitmap? {
      val uri = Uri.parse(raw)
      val path = when (uri.scheme) {
        "file" -> uri.path
        null -> raw
        else -> null
      }
      val dataUri = raw.startsWith("data:image/") && raw.substringBefore(',').endsWith(";base64")
      if (path == null && !dataUri) return null
      return try {
        val bytes = if (dataUri) Base64.decode(raw.substringAfter(','), Base64.DEFAULT) else null
        val resourceId = if (uri.scheme == null && !raw.contains('/') && context != null) {
          context.resources.getIdentifier(raw, "drawable", context.packageName)
        } else 0
        fun openImage(): java.io.InputStream = when {
          bytes != null -> bytes.inputStream()
          resourceId != 0 -> requireNotNull(context).resources.openRawResource(resourceId)
          else -> File(requireNotNull(path)).inputStream()
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true; inScaled = false }
        openImage().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth.toLong() != sprite.cellWidth.toLong() * sprite.columns || bounds.outHeight.toLong() != sprite.cellHeight.toLong() * sprite.rows) null
        else {
          var sample = 1
          while (sprite.cellWidth / sample / 2 >= target && sprite.cellHeight / sample / 2 >= target) sample *= 2
          val options = BitmapFactory.Options().apply { inSampleSize = sample; inScaled = false }
          openImage().use { BitmapFactory.decodeStream(it, null, options) }
        }
      } catch (error: Exception) {
        null
      } catch (error: OutOfMemoryError) {
        null
      }
    }
  }

  fun release() {
    released = true
    decodeVersion++
    unschedule()
    decoder.shutdownNow()
    bitmap?.recycle()
    bitmap = null
  }
}
