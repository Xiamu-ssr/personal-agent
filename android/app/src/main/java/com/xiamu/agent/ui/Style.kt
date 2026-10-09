package com.xiamu.agent.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBackIos
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Silver-blue metal + champagne gold (spec §四). */
object Pal {
    val Ink = Color(0xFF252E38)
    val Muted = Color(0xFF728093)
    val Faint = Color(0xFF8F99A6)
    val Line = Color(0x1F7589A0)
    val Card = Color(0xD6FBFCFE)
    val CardSolid = Color(0xFFFBFCFE)
    val Field = Color(0x75E0E4EA)
    val Icon = Color(0xFF506880)
    val Link = Color(0xFF49799D)
    val GoldInk = Color(0xFF6C4A25)
    val Gold = Color(0xFFB18C53)
    val Danger = Color(0xFFB4505F)
    val Online = Color(0xFF5BA37A)
    val UserBubble = Color(0x339AAFC5)
    val UserText = Color(0xFF3B526C)
    val Quiet = Color(0xFFE2EEF5)
    val QuietText = Color(0xFF477799)
}

val GoldBrush = Brush.linearGradient(
    0f to Color(0xFFFFFBED), 0.22f to Color(0xFFF3DFB0), 0.45f to Color(0xFFE2C88E),
    0.62f to Color(0xFFEAD299), 1f to Color(0xFF9C7440),
)
val GoldRim = Brush.horizontalGradient(
    listOf(Color(0xFF8E6835), Color(0xFFD1AD66), Color(0xFFFFF2CA), Color(0xFFBB9250), Color(0xFF825D2E)),
)
private val GoldEdge = Color(0x82BA9659)
private val GoldShine = Brush.horizontalGradient(listOf(Color.Transparent, Color(0xFFFFF8DF), Color.Transparent))

@Composable
fun AgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Pal.Gold, onPrimary = Color.White, background = Color(0xFFE5E9EE), surface = Pal.CardSolid,
            onSurface = Pal.Ink, onBackground = Pal.Ink, outline = Pal.Faint, error = Pal.Danger,
        ),
        typography = Typography(bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 24.sp, color = Pal.Ink)),
        content = content,
    )
}

/** The app canvas: silver-blue at the top fading to near-white, with a soft light on the right. */
fun Modifier.canvasBackground() = drawBehind {
    drawRect(Brush.verticalGradient(0f to Color(0xFFC9D3DF), 0.45f to Color(0xFFE5E9EE), 1f to Color(0xFFEEF1F4)))
    drawRect(
        Brush.radialGradient(
            listOf(Color(0xB0FFFFFF), Color.Transparent),
            center = Offset(size.width * 1.05f, size.height * 0.3f), radius = size.width * 0.95f,
        ),
    )
}

fun Modifier.card(radius: Dp = 22.dp, color: Color = Pal.Card): Modifier {
    val shape = RoundedCornerShape(radius)
    return shadow(10.dp, shape, ambientColor = Color(0x1A253751), spotColor = Color(0x1A253751))
        .background(color, shape)
        .border(1.dp, Color(0xB3FFFFFF), shape)
}

/** Champagne-gold metal fill with a thin highlight along the top edge. */
fun Modifier.gold(shape: Shape = CircleShape) = clip(shape)
    .background(GoldBrush)
    .border(1.dp, GoldEdge, shape)
    .drawWithContent {
        drawContent()
        drawRect(GoldShine, topLeft = Offset(size.width * 0.15f, 2.dp.toPx()), size = androidx.compose.ui.geometry.Size(size.width * 0.7f, 1.dp.toPx()))
    }

/** clickable without the grey ripple; most surfaces here are glassy and the ripple looks muddy on them. */
@Composable
fun Modifier.tap(enabled: Boolean = true, onClick: () -> Unit): Modifier =
    clickable(remember { MutableInteractionSource() }, indication = null, enabled = enabled, onClick = onClick)

@Composable
fun Screen(content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.fillMaxSize().canvasBackground(), content = content)
}

/** Big page title (今日 / 任务 / 记忆) with round icon buttons on the right. */
@Composable
fun PageHeader(title: String, sub: String? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, top = 18.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Pal.Ink, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), content = actions)
        }
        if (sub != null) Text(sub, fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 4.dp))
    }
}

/** Nav bar for pushed pages: back chevron + small centered caption. Pair with [BigTitle] as the first list item. */
@Composable
fun SubHeader(title: String, onBack: () -> Unit) {
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp).height(52.dp)) {
        Box(Modifier.align(Alignment.CenterStart).size(44.dp).clip(CircleShape).tap(onClick = onBack), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBackIos, "返回", tint = Pal.Icon, modifier = Modifier.size(18.dp).offset(x = 3.dp))
        }
        Text(title, fontSize = 14.sp, color = Pal.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 56.dp))
    }
}

@Composable
fun BigTitle(title: String, sub: String? = null) {
    Column(Modifier.fillMaxWidth().padding(start = 4.dp, top = 4.dp, bottom = 8.dp)) {
        Text(title, fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Pal.Ink)
        if (sub != null) Text(sub, fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
fun CircleButton(icon: ImageVector, desc: String, onClick: () -> Unit) {
    Box(
        Modifier.size(42.dp).clip(CircleShape).background(Color(0x99FFFFFF)).border(1.dp, Color(0x80FFFFFF), CircleShape).tap(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, desc, tint = Pal.Icon, modifier = Modifier.size(20.dp)) }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 22.dp, bottom = 10.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink, modifier = Modifier.weight(1f))
        trailing()
    }
}

/** A white card holding rows separated by hairlines. */
@Composable
fun CardList(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().card().padding(horizontal = 18.dp), content = content)
}

@Composable
fun Hairline() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Pal.Line))
}

@Composable
fun IconTile(icon: ImageVector, tint: Color, size: Dp = 36.dp) {
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * 0.32f)).background(tint.copy(alpha = 0.1f)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size(size * 0.56f)) }
}

/** One row in a [CardList]. Put [Hairline]s between rows yourself (first row has none). */
@Composable
fun ListRow(
    title: String,
    sub: String? = null,
    icon: ImageVector? = null,
    tint: Color = Pal.Icon,
    subColor: Color = Pal.Muted,
    subLines: Int = 1,
    dim: Boolean = false,
    trailing: @Composable (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).then(if (onClick != null) Modifier.tap(onClick = onClick) else Modifier)
            .padding(vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            IconTile(icon, if (dim) Pal.Faint else tint)
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = if (dim) Pal.Faint else Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!sub.isNullOrBlank()) {
                Text(sub, fontSize = 12.sp, lineHeight = 17.sp, color = if (dim) Pal.Faint else subColor, maxLines = subLines,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
        }
        when {
            trailing != null -> Box(Modifier.padding(start = 10.dp)) { trailing() }
            onClick != null -> Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = Color(0xFF9DAEC2), modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
fun GoldButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Box(
        modifier.height(52.dp).then(if (enabled) Modifier.gold(shape) else Modifier.clip(shape).background(Color(0xFFDDE2E8)))
            .tap(enabled, onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = if (enabled) Pal.GoldInk else Pal.Faint) }
}

/** Plain silver button for secondary actions. */
@Composable
fun SilverButton(text: String, modifier: Modifier = Modifier, color: Color = Color(0xFF5B6B7F), onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier.height(48.dp).clip(shape).background(Brush.verticalGradient(listOf(Color(0xFFFDFEFE), Color(0xFFE9EDF2))))
            .border(1.dp, Color(0xBAFFFFFF), shape).tap(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = color) }
}

@Composable
fun GoldChip(text: String) {
    Box(Modifier.gold(RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 6.dp)) {
        Text(text, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, color = Pal.GoldInk)
    }
}

@Composable
fun QuietButton(text: String, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(14.dp)).background(Pal.Quiet).border(1.dp, Color(0x3BBFCDDB), RoundedCornerShape(14.dp))
            .tap(onClick = onClick).padding(horizontal = 14.dp, vertical = 7.dp),
    ) { Text(text, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, color = Pal.QuietText) }
}

@Composable
fun Tag(text: String, color: Color = Pal.Muted) {
    Text(text, fontSize = 11.sp, lineHeight = 15.sp, color = color, modifier = Modifier.clip(RoundedCornerShape(8.dp))
        .background(color.copy(alpha = 0.1f)).padding(horizontal = 8.dp, vertical = 3.dp))
}

/** Segmented tabs: the selected one sits on a gold pill with a short gold rim below. */
@Composable
fun SegTabs(labels: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    Row(modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f).tap { onSelect(i) }) {
                Box(
                    Modifier.then(if (on) Modifier.gold(RoundedCornerShape(12.dp)) else Modifier).padding(horizontal = 9.dp, vertical = 7.dp),
                ) {
                    Text(label, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, color = if (on) Pal.GoldInk else Color(0xFF70829A))
                }
                Box(Modifier.padding(top = 3.dp).width(20.dp).height(2.dp).clip(CircleShape).then(if (on) Modifier.background(GoldRim) else Modifier))
            }
        }
    }
}

@Composable
fun GoldSwitch(checked: Boolean, onChange: (Boolean) -> Unit) {
    val x = animateDpAsState(if (checked) 20.dp else 2.dp, label = "knob")
    val shape = RoundedCornerShape(14.dp)
    Box(
        Modifier.size(46.dp, 28.dp).then(if (checked) Modifier.gold(shape) else Modifier.clip(shape).background(Color(0xFFD9DFE6)))
            .tap { onChange(!checked) },
    ) {
        Box(
            Modifier.offset { androidx.compose.ui.unit.IntOffset(x.value.roundToPx(), 2.dp.roundToPx()) }.size(24.dp).shadow(2.dp, CircleShape)
                .background(Brush.linearGradient(listOf(Color.White, if (checked) Color(0xFFF2E9D8) else Color(0xFFF4F6F8))), CircleShape),
        )
    }
}

@Composable
fun StatusDot(color: Color, size: Dp = 7.dp) {
    Box(Modifier.size(size).background(color, CircleShape).border(1.dp, Color.White, CircleShape))
}

/** Silver metal sphere: 豆豆's face everywhere. */
@Composable
fun Avatar(size: Dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val r = this.size.minDimension / 2
        drawCircle(Color(0x22576A84), radius = r, center = center.copy(y = center.y + r * 0.06f))
        drawCircle(
            Brush.radialGradient(
                0f to Color.White, 0.45f to Color(0xFFDCE6F2), 1f to Color(0xFFAFC0D3),
                center = Offset(r * 0.72f, r * 0.62f), radius = r * 1.5f,
            ),
            radius = r * 0.97f,
        )
        // rim light along the lower right and a glossy highlight up top
        drawCircle(
            Brush.radialGradient(listOf(Color.Transparent, Color(0x55FFFFFF)), center = Offset(r * 0.8f, r * 0.7f), radius = r * 1.35f),
            radius = r * 0.97f,
        )
        drawOval(
            Brush.verticalGradient(listOf(Color(0xE6FFFFFF), Color(0x00FFFFFF)), startY = r * 0.28f, endY = r * 0.95f),
            topLeft = Offset(r * 0.45f, r * 0.26f), size = androidx.compose.ui.geometry.Size(r * 0.95f, r * 0.62f),
        )
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(36.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(22.dp), color = Pal.Gold, strokeWidth = 2.dp)
    }
}

@Composable
fun EmptyNote(text: String, modifier: Modifier = Modifier) {
    Text(text, fontSize = 14.sp, lineHeight = 22.sp, color = Pal.Muted, modifier = modifier.fillMaxWidth().padding(vertical = 20.dp))
}

@Composable
fun ErrorNote(text: String) {
    Text(text, fontSize = 13.sp, color = Pal.Danger, modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp, horizontal = 4.dp))
}

fun pagePadding(bottom: Dp) = PaddingValues(start = 20.dp, end = 20.dp, bottom = bottom + 16.dp)

/** A pushed page: nav bar on top, scrolling content below. */
@Composable
fun SubPage(title: String, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Screen {
        Column(Modifier.fillMaxSize()) {
            SubHeader(title, com.xiamu.agent.ui.Nav::back)
            androidx.compose.foundation.lazy.LazyColumn(
                Modifier.fillMaxSize().navigationBarsPadding(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
                content = content,
            )
        }
    }
}
