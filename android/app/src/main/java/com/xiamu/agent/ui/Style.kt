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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object ThemeState {
    val preference = androidx.compose.runtime.mutableStateOf("system")
    val dark = androidx.compose.runtime.mutableStateOf(false)
    fun restore() { preference.value = com.xiamu.agent.Prefs.appearance }
    fun select(value: String) { preference.value=value; com.xiamu.agent.Prefs.appearance=value }
}
object Pal {
    private val dark get()=ThemeState.dark.value
    val Background get()=if(dark) Color.Black else Color.White
    val Ink get()=if(dark) Color.White else Color.Black
    val Muted get()=if(dark) Color(0xFF999999) else Color(0xFF707070)
    val Faint get()=Muted
    val Line get()=if(dark) Color(0xFF292929) else Color(0xFFE8E8E8)
    val Card get()=if(dark) Color(0xFF202020) else Color(0xFFF3F3F3)
    val CardSolid get()=Card
    val Field get()=Card
    val Icon get()=Ink
    val Link get()=if(dark) Color(0xFF69AFFF) else Color(0xFF0668CE)
    val GoldInk get()=Ink
    val Gold get()=Ink
    val Danger get()=Muted
    val Online get()=Ink
    val Info get()=Muted
    val UserBubble get()=if(dark) Color(0xFFE8E8E8) else Color(0xFF202020)
    val UserText get()=Background
    val Quiet get()=if(dark) Color(0xFF363636) else Color(0xFFE6E6E6)
    val QuietText get()=Ink
}

object Type {
    val Large = 28.sp
    val Page = 20.sp
    val CardTitle = 17.sp
    val Body = 15.sp
    val Secondary = 13.sp
    val Label = 12.sp
    val Tiny = 11.sp
    val Number = 26.sp
    val BodyLine = 22.sp
    val SecondaryLine = 19.sp
    val LabelLine = 16.sp
    val titleFamily get() = androidx.compose.ui.text.font.FontFamily.SansSerif
    val bodyWeight get() = FontWeight.Normal
    fun body(size: Int) = TextStyle(fontFamily = androidx.compose.ui.text.font.FontFamily.SansSerif, fontSize = size.sp,
        lineHeight = (size * 1.45f).sp, fontWeight = bodyWeight, fontFeatureSettings = "tnum", color = Pal.Ink)
    fun title(size: Int) = body(size).copy(fontFamily = titleFamily, fontWeight = FontWeight.SemiBold)
}

val GoldBrush get() = Brush.linearGradient(listOf(Pal.Quiet, Pal.Quiet))
val GoldRim get() = Brush.horizontalGradient(listOf(Pal.Ink, Pal.Ink))

@Composable
fun AgentTheme(content: @Composable () -> Unit) {
    val systemDark=androidx.compose.foundation.isSystemInDarkTheme()
    val night=when(ThemeState.preference.value) { "light" -> false; "dark" -> true; else -> systemDark }
    ThemeState.dark.value=night
    val view = androidx.compose.ui.platform.LocalView.current
    val background = Pal.Background
    androidx.compose.runtime.SideEffect {
        var context = view.context
        while (context is android.content.ContextWrapper && context !is android.app.Activity) context = context.baseContext
        (context as? android.app.Activity)?.window?.let { window ->
            window.statusBarColor = background.toArgb()
            window.navigationBarColor = background.toArgb()
            window.isNavigationBarContrastEnforced = false
            androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !night
                isAppearanceLightNavigationBars = !night
            }
        }
    }
    val colors = if (night) androidx.compose.material3.darkColorScheme() else lightColorScheme()
    MaterialTheme(
        colorScheme = colors.copy(primary = Pal.Ink, onPrimary = Pal.Background, primaryContainer = Pal.Quiet,
            onPrimaryContainer = Pal.Ink, secondary = Pal.Gold, secondaryContainer = Pal.Quiet,
            onSecondaryContainer = Pal.Ink, background = background, surface = Pal.Card, surfaceVariant = Pal.Field,
            surfaceContainer = Pal.Card, surfaceContainerHigh = Pal.Card, surfaceContainerHighest = Pal.Field,
            surfaceContainerLow = Pal.Card, surfaceContainerLowest = Pal.Background, surfaceDim = Pal.Background,
            surfaceBright = Pal.Card, surfaceTint = Color.Transparent, onSurface = Pal.Ink, onSurfaceVariant = Pal.Muted,
            onBackground = Pal.Ink, outline = Pal.Line, outlineVariant = Pal.Line, error = Pal.Danger,
            errorContainer = Pal.Danger.copy(alpha = .12f), onErrorContainer = Pal.Danger),
        typography = Typography(displayLarge = Type.title(28), displayMedium = Type.title(28), displaySmall = Type.title(26),
            headlineLarge = Type.title(28), headlineMedium = Type.title(26), headlineSmall = Type.title(20),
            titleLarge = Type.title(20), titleMedium = Type.title(17), titleSmall = Type.title(15),
            bodyLarge = Type.body(15), bodyMedium = Type.body(15), bodySmall = Type.body(13),
            labelLarge = Type.body(13), labelMedium = Type.body(12), labelSmall = Type.body(11)),
        content = content,
    )
}

fun Modifier.canvasBackground() = background(Pal.Background)
fun Modifier.card(radius: Dp = 22.dp, color: Color = Pal.Card): Modifier = background(color, RoundedCornerShape(radius))
fun Modifier.gold(shape: Shape = CircleShape) = clip(shape).background(Pal.Quiet)

/** clickable without the grey ripple; most surfaces here are glassy and the ripple looks muddy on them. */
@Composable
fun Modifier.tap(enabled: Boolean = true, onClick: () -> Unit): Modifier =
    clickable(remember { MutableInteractionSource() }, indication = null, enabled = enabled, onClick = onClick)

@Composable
fun Screen(content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.fillMaxSize().canvasBackground(), content = content)
}

/** Page title and contextual actions. */
@Composable
fun PageHeader(title: String, sub: String? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, top = 18.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = Type.title(28), color = Pal.Ink, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), content = actions)
        }
        if (sub != null) Text(sub, fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 4.dp))
    }
}

/** Nav bar for pushed pages: back chevron + small centered caption. Pair with [BigTitle] as the first list item. */
@Composable
fun SubHeader(title: String, onBack: () -> Unit) {
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp).height(52.dp)) {
        Box(Modifier.align(Alignment.CenterStart).size(44.dp).clip(CircleShape).background(Pal.Card).tap(onClick = onBack), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBackIos, "返回", tint = Pal.Icon, modifier = Modifier.size(18.dp).offset(x = 3.dp))
        }
        Text(title, style = Type.title(17), color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 56.dp))
    }
}

@Composable
fun BigTitle(title: String, sub: String? = null) {
    Column(Modifier.fillMaxWidth().padding(start = 4.dp, top = 4.dp, bottom = 8.dp)) {
        Text(title, style = Type.title(28), color = Pal.Ink)
        if (sub != null) Text(sub, fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
fun CircleButton(icon: ImageVector, desc: String, onClick: () -> Unit) {
    Box(
        Modifier.size(42.dp).clip(CircleShape).background(Pal.Card).tap(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, desc, tint = Pal.Icon, modifier = Modifier.size(20.dp)) }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 22.dp, bottom = 10.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = Type.title(17), color = Pal.Ink, modifier = Modifier.weight(1f))
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
    leading: @Composable (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).then(if (onClick != null) Modifier.tap(onClick = onClick) else Modifier)
            .padding(vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(14.dp))
        } else if (icon != null) {
            IconTile(icon, if (dim) Pal.Faint else tint)
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = if (dim) Pal.Faint else Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!sub.isNullOrBlank()) {
                Text(sub, fontSize = 13.sp, lineHeight = 19.sp, color = if (dim) Pal.Faint else subColor, maxLines = subLines,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
        }
        when {
            trailing != null -> Box(Modifier.padding(start = 10.dp)) { trailing() }
            onClick != null -> Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = Pal.Muted, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
fun GoldButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Box(
        modifier.height(52.dp).then(if (enabled) Modifier.gold(shape) else Modifier.clip(shape).background(Pal.Field))
            .tap(enabled, onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = if (enabled) Pal.GoldInk else Pal.Faint) }
}

/** Neutral secondary action. */
@Composable
fun SilverButton(text: String, modifier: Modifier = Modifier, color: Color = Pal.Ink, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier.height(48.dp).clip(shape).background(Pal.Card).tap(onClick = onClick),
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
        Modifier.clip(RoundedCornerShape(14.dp)).background(Pal.Quiet)
            .tap(onClick = onClick).padding(horizontal = 14.dp, vertical = 7.dp),
    ) { Text(text, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, color = Pal.QuietText) }
}

@Composable
fun Tag(text: String, color: Color = Pal.Muted) {
    Text(text, fontSize = 11.sp, lineHeight = 15.sp, color = color, modifier = Modifier.clip(RoundedCornerShape(8.dp))
        .background(color.copy(alpha = 0.1f)).padding(horizontal = 8.dp, vertical = 3.dp))
}

/** Neutral segmented controls. */
@Composable
fun SegTabs(labels: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    Row(modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f).tap { onSelect(i) }) {
                Box(
                    Modifier.then(if (on) Modifier.gold(RoundedCornerShape(12.dp)) else Modifier).padding(horizontal = 9.dp, vertical = 7.dp),
                ) {
                    Text(label, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, color = if (on) Pal.GoldInk else Pal.Muted)
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
        Modifier.size(46.dp, 28.dp).then(if (checked) Modifier.clip(shape).background(Pal.Ink) else Modifier.clip(shape).background(Pal.Line))
            .tap { onChange(!checked) },
    ) {
        Box(
            Modifier.offset { androidx.compose.ui.unit.IntOffset(x.value.roundToPx(), 2.dp.roundToPx()) }.size(24.dp).shadow(2.dp, CircleShape)
                .background(Brush.linearGradient(listOf(Pal.Card, Pal.Card)), CircleShape),
        )
    }
}

@Composable
fun StatusDot(color: Color, size: Dp = 7.dp) {
    Box(Modifier.size(size).background(color, CircleShape))
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

fun pagePadding(bottom: Dp) = PaddingValues(start = 20.dp, end = 20.dp, top = FloatingHeaderSpace, bottom = bottom + 16.dp)

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
