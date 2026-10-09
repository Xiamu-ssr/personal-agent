package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.TextUnit

private sealed class Block {
    class Heading(val level: Int, val text: String) : Block()
    class Bullet(val indent: Int, val marker: String, val text: String, val pointers: List<String>) : Block()
    class Para(val text: String, val pointers: List<String>) : Block()
    class Quote(val text: String) : Block()
    class Code(val text: String) : Block()
    class Table(val rows: List<List<String>>) : Block()
    data object Rule : Block()
    data object Gap : Block()
}

/** Memory files end lines with `→ work/求职.md`-style pointers; pull those out so they render as chips. */
private val pointerRe = Regex("""\s*→\s*(.+)$""")
private val mdPath = Regex("""[^\s、，,；;（）()\[\]\x60]+\.md""")

private fun splitPointers(line: String, pointers: Boolean): Pair<String, List<String>> {
    if (!pointers) return line to emptyList()
    val m = pointerRe.find(line) ?: return line to emptyList()
    val paths = mdPath.findAll(m.groupValues[1]).map { it.value.removePrefix("data/memory/") }.toList()
    if (paths.isEmpty()) return line to emptyList()
    return line.substring(0, m.range.first).trimEnd() to paths
}

private fun parse(src: String, pointers: Boolean): List<Block> {
    val out = mutableListOf<Block>()
    val lines = src.lines()
    var i = 0
    while (i < lines.size) {
        val raw = lines[i]
        val line = raw.trimEnd()
        val t = line.trimStart()
        when {
            t.startsWith("```") -> {
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) code.appendLine(lines[i++])
                out += Block.Code(code.toString().trimEnd())
            }
            t.startsWith("|") -> {
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                    val cells = lines[i].trim().trim('|').split("|").map { it.trim() }
                    if (!cells.all { it.matches(Regex(":?-{2,}:?")) }) rows += cells
                    i++
                }
                i--
                out += Block.Table(rows)
            }
            line.isBlank() -> if (out.lastOrNull() != Block.Gap) out += Block.Gap
            t.matches(Regex("(-{3,}|\\*{3,}|_{3,})")) -> out += Block.Rule
            t.startsWith("#") -> {
                val level = t.takeWhile { it == '#' }.length
                out += Block.Heading(level, t.drop(level).trim())
            }
            t.startsWith(">") -> out += Block.Quote(t.drop(1).trim())
            t.matches(Regex("[-*+]\\s+.*")) || t.matches(Regex("\\d+[.)]\\s+.*")) -> {
                val num = Regex("^(\\d+)[.)]\\s+").find(t)
                val marker = if (num != null) "${num.groupValues[1]}." else "•"
                val body = if (num != null) t.substring(num.range.last + 1) else t.drop(1).trimStart()
                val (text, ptr) = splitPointers(body, pointers)
                out += Block.Bullet((line.length - t.length) / 2, marker, text, ptr)
            }
            else -> {
                val (text, ptr) = splitPointers(t, pointers)
                out += Block.Para(text, ptr)
            }
        }
        i++
    }
    while (out.firstOrNull() == Block.Gap) out.removeAt(0)
    while (out.lastOrNull() == Block.Gap) out.removeAt(out.size - 1)
    return out
}

/**
 * Enough Markdown for chat and memory files: headings, lists, quotes, code, tables, **bold**, *italic*, `code`, links.
 * With [onPointer], trailing `→ x/y.md` pointers become tappable chips (paths relative to data/memory/).
 */
@Composable
fun Markdown(src: String, modifier: Modifier = Modifier, color: Color = Pal.Ink, fontSize: Int = 15, onPointer: ((String) -> Unit)? = null) {
    val blocks = remember(src, onPointer != null) { parse(src, onPointer != null) }
    val body = fontSize.sp
    val lh = (fontSize * 1.65f).sp
    Column(modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        for (b in blocks) when (b) {
            is Block.Heading -> Text(
                inline(b.text), fontWeight = FontWeight.SemiBold, color = Pal.Ink,
                fontSize = when (b.level) { 1 -> (fontSize + 4).sp; 2 -> (fontSize + 2).sp; else -> (fontSize + 1).sp },
                lineHeight = (fontSize * 1.9f).sp, modifier = Modifier.padding(top = 4.dp),
            )
            is Block.Bullet -> Row(Modifier.padding(start = (b.indent * 14).dp)) {
                Text(b.marker, fontSize = body, lineHeight = lh, color = Pal.Muted, modifier = Modifier.width(if (b.marker == "•") 16.dp else 22.dp))
                PointerText(b.text, b.pointers, body, lh, color, onPointer)
            }
            is Block.Para -> PointerText(b.text, b.pointers, body, lh, color, onPointer)
            is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().padding(vertical = 2.dp).background(Color(0x40728093), RoundedCornerShape(2.dp)))
                Text(inline(b.text), fontSize = body, lineHeight = lh, color = Pal.Muted, modifier = Modifier.padding(start = 10.dp))
            }
            is Block.Code -> Text(
                b.text, fontFamily = FontFamily.Monospace, fontSize = (fontSize - 3).sp, lineHeight = (fontSize * 1.3f).sp, color = Color(0xFF3C4A5A),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0x14506880))
                    .horizontalScroll(rememberScrollState()).padding(12.dp),
            )
            is Block.Table -> MdTable(b.rows, fontSize)
            Block.Rule -> Box(Modifier.padding(vertical = 6.dp).fillMaxWidth().height(1.dp).background(Pal.Line))
            Block.Gap -> Box(Modifier.height(2.dp))
        }
    }
}

@Composable
private fun PointerText(text: String, paths: List<String>, fontSize: TextUnit, lineHeight: TextUnit, color: Color, onPointer: ((String) -> Unit)?) {
    if (paths.isEmpty() || onPointer == null) {
        Text(inline(text), fontSize = fontSize, lineHeight = lineHeight, color = color)
        return
    }
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val style = LocalTextStyle.current.copy(fontSize = 11.sp, lineHeight = 15.sp)
    val chips = paths.mapIndexed { i, p ->
        val label = p.substringAfterLast('/').removeSuffix(".md")
        val size = measurer.measure(label, style, softWrap = false).size
        val width = with(density) { (size.width + 31.dp.toPx()).toSp() }
        val height = with(density) { (15.sp.toPx() + 6.dp.toPx()).toSp() }
        "pointer:$i" to InlineTextContent(Placeholder(width, height, PlaceholderVerticalAlign.TextCenter)) {
            Row(
                Modifier.fillMaxSize().clip(RoundedCornerShape(9.dp)).background(Color(0x1A4A77A0)).tap { onPointer(p) }.padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Description, null, tint = Pal.Link, modifier = Modifier.padding(end = 3.dp).size(12.dp))
                Text(label, style = style, color = Pal.Link, maxLines = 1, softWrap = false)
            }
        }
    }.toMap()
    val annotated = remember(text, paths) {
        buildAnnotatedString {
            append(inline(text))
            paths.forEachIndexed { i, p ->
                append(' ')
                appendInlineContent("pointer:$i", p.substringAfterLast('/').removeSuffix(".md"))
            }
        }
    }
    Text(annotated, fontSize = fontSize, lineHeight = lineHeight, color = color, inlineContent = chips)
}

@Composable
private fun MdTable(rows: List<List<String>>, fontSize: Int) {
    if (rows.isEmpty()) return
    val cols = rows.maxOf { it.size }
    val wide = cols > 3
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0x0D506880))
            .then(if (wide) Modifier.horizontalScroll(rememberScrollState()) else Modifier),
    ) {
        rows.forEachIndexed { r, row ->
            if (r > 0) Box(Modifier.then(if (wide) Modifier.width((cols * 120).dp) else Modifier.fillMaxWidth()).height(1.dp).background(Pal.Line))
            Row {
                for (c in 0 until cols) {
                    Text(
                        inline(row.getOrElse(c) { "" }), fontSize = (fontSize - 2).sp, lineHeight = (fontSize * 1.4f).sp,
                        fontWeight = if (r == 0) FontWeight.SemiBold else FontWeight.Normal, color = Pal.Ink,
                        modifier = (if (wide) Modifier.width(120.dp) else Modifier.weight(1f).widthIn(min = 40.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

private val linkStyle = TextLinkStyles(SpanStyle(color = Pal.Link, textDecoration = TextDecoration.Underline))

fun inline(s: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            s.startsWith("**", i) && s.indexOf("**", i + 2) > i + 2 -> {
                val end = s.indexOf("**", i + 2)
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inline(s.substring(i + 2, end))) }
                i = end + 2
            }
            c == '`' && s.indexOf('`', i + 1) > i -> {
                val end = s.indexOf('`', i + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 0.9.em, background = Color(0x1A506880))) {
                    append(s.substring(i + 1, end))
                }
                i = end + 1
            }
            c == '[' && Regex("""^\[([^\]]+)]\((https?://[^)\s]+)\)""").find(s.substring(i)) != null -> {
                val m = Regex("""^\[([^\]]+)]\((https?://[^)\s]+)\)""").find(s.substring(i))!!
                withLink(LinkAnnotation.Url(m.groupValues[2], linkStyle)) { append(m.groupValues[1]) }
                i += m.value.length
            }
            c == '*' && i + 1 < s.length && s[i + 1] != ' ' && s.indexOf('*', i + 1) > i + 1 -> {
                val end = s.indexOf('*', i + 1)
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.substring(i + 1, end)) }
                i = end + 1
            }
            else -> {
                append(c)
                i++
            }
        }
    }
}
