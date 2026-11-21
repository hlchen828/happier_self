package dev.happier.petoverlay

import android.graphics.Color
import org.json.JSONObject

internal data class PetItem(val sessionId: String, val dismissKey: String, val title: String, val status: String, val subtitle: String?)
internal data class PetAnimation(val row: Int, val frames: Int, val durationsMs: List<Double>) {
  private val cycleMs = durationsMs.sum()
  fun frameAt(elapsedMs: Double): Int {
    var remaining = elapsedMs % cycleMs
    durationsMs.forEachIndexed { index, duration ->
      if (remaining < duration) return index
      remaining -= duration
    }
    return 0
  }

  fun untilNextFrame(elapsedMs: Double): Double {
    var remaining = elapsedMs % cycleMs
    durationsMs.forEach { duration ->
      if (remaining < duration) return duration - remaining
      remaining -= duration
    }
    return durationsMs.first()
  }
}
internal data class PetSprite(val cellWidth: Int, val cellHeight: Int, val columns: Int, val rows: Int, val animations: Map<String, PetAnimation>)
internal data class PetLabels(val title: String, val stop: String, val activity: String, val disconnected: String, val open: String, val close: String, val statuses: Map<String, String>)
internal data class PetColors(val background: Int, val text: Int, val secondary: Int, val accent: Int, val statuses: Map<String, Int> = emptyMap())
internal data class PetPayload(
  val state: String,
  val connected: Boolean,
  val spriteUri: String?,
  val sprite: PetSprite?,
  val reducedMotion: Boolean,
  val items: List<PetItem>,
  val labels: PetLabels,
  val colors: PetColors,
  val sizeScale: Float
) {
  val summary: String get() = if (connected) labels.activity else labels.disconnected
  fun status(item: PetItem): String = if (connected) labels.statuses[item.status] ?: labels.activity else labels.disconnected

  companion object {
    fun parse(raw: String): PetPayload {
      val json = JSONObject(raw)
      val labels = json.getJSONObject("labels")
      val colors = json.getJSONObject("colors")
      val items = json.getJSONArray("items")
      val scale = json.getDouble("sizeScale")
      require(scale.isFinite() && scale > 0 && scale.toFloat().isFinite()) { "Invalid sizeScale" }
      val sprite = json.optJSONObject("sprite")?.let { source ->
        val width = source.getInt("cellWidth")
        val height = source.getInt("cellHeight")
        val columns = source.getInt("columns")
        val rows = source.getInt("rows")
        require(width > 0 && height > 0 && columns > 0 && rows > 0) { "Invalid sprite geometry" }
        val animations = source.getJSONObject("animations")
        PetSprite(width, height, columns, rows, animations.keys().asSequence().associateWith { key ->
          val animation = animations.getJSONObject(key)
          val row = animation.getInt("row")
          val frames = animation.getInt("frames")
          val rawDurations = animation.getJSONArray("durationsMs")
          val durations = (0 until rawDurations.length()).map { rawDurations.getDouble(it) }
          require(row in 0 until rows && frames in 1..columns && durations.size == frames && durations.all { it.isFinite() && it > 0 } && durations.sum().isFinite()) { "Invalid sprite animation" }
          PetAnimation(row, frames, durations)
        })
      }
      val statuses = labels.getJSONObject("statuses")
      return PetPayload(
        json.getString("state"), json.getBoolean("connected"),
        if (json.isNull("spriteUri")) null else json.getString("spriteUri"), sprite,
        json.getBoolean("reducedMotion"),
        (0 until items.length()).map { index ->
          val item = items.getJSONObject(index)
          PetItem(item.getString("sessionId"), item.getString("dismissKey"), item.getString("title"), item.getString("status"), if (item.isNull("subtitle")) null else item.getString("subtitle"))
        },
        PetLabels(labels.getString("title"), labels.getString("stop"), labels.getString("activity"), labels.getString("disconnected"), labels.getString("open"), labels.getString("close"), statuses.keys().asSequence().associateWith { statuses.getString(it) }),
        PetColors(
          Color.parseColor(colors.getString("background")), Color.parseColor(colors.getString("text")),
          Color.parseColor(colors.getString("secondary")), Color.parseColor(colors.getString("accent")),
          colors.optJSONObject("statuses")?.let { statusColors ->
            statusColors.keys().asSequence().associateWith { Color.parseColor(statusColors.getString(it)) }
          } ?: emptyMap()
        ),
        scale.toFloat()
      )
    }
  }
}
