package com.xiamu.agent.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.Dp
import com.xiamu.agent.AvatarChoice

object Appearance { val choice = mutableStateOf(AvatarChoice()) }

/** Shared Android / Mac avatar parameter table (unit square, sRGB, all paths close with Z).
 * IDs: shape bean / girl / boy / cat; palette mist / dusk / mint / sakura.
 * Palette    skyTop  skyMid  skyBottom glow
 * mist       8EAECD  CEDDEC  EEF4FA    FFEAC5
 * dusk       CCAA91  EAD2AB  FCF0D4    FFF6CF
 * mint       88B8B0  C5E1D7  EAF7EF    FFECCE
 * sakura     C3A3BE  EAD1DF  FBEFF2    FFF0D1
 * Gradient stops: 0 / .55 / 1, top to bottom.
 * Glow       center      radius alpha
 * warm       (.32,.25)   .48    .70 -> 0 (palette glow color)
 * white      (.67,.42)   .40    .60 -> 0 (FFFFFF)
 * Cloud ellipses (x,y,w,h,alpha): (-.15,.60,.80,.20,.45),(.30,.52,.80,.22,.50),
 * (-.08,.72,1.20,.28,.68),(.20,.83,.92,.18,.45). White; top->bottom alpha -> 0.
 * Silhouettes use these normalized cubic Bezier control/end points (M + C* + Z):
 * bean M .50,.06 C .22,.03 .08,.28 .12,.55 C .15,.84 .40,.99 .66,.89
 *      C .92,.80 1,.52 .81,.37 C .64,.25 .74,.10 .50,.06
 * girl M .45,.05 C .20,.02 .14,.23 .19,.46 C .12,.61 .17,.74 .26,.80
 *      C .16,.86 .12,.93 .12,.96 C .35,1 .72,1 .91,.96 C .89,.82 .71,.77 .63,.72
 *      C .64,.66 .66,.62 .69,.57 C .82,.57 .84,.51 .80,.47 C .86,.43 .88,.42 .84,.37
 *      C .76,.28 .78,.07 .57,.05 C .52,.04 .48,.04 .45,.05
 * boy  M .43,.07 C .20,.08 .16,.27 .24,.42 C .19,.52 .23,.66 .35,.70
 *      C .35,.77 .24,.79 .17,.86 C .12,.90 .10,.94 .10,.97
 *      C .38,1 .71,1 .93,.96 C .89,.81 .72,.76 .63,.72
 *      C .64,.66 .65,.63 .69,.58 C .79,.58 .84,.54 .80,.49
 *      C .87,.47 .88,.44 .83,.39 C .74,.32 .79,.20 .68,.12
 *      C .61,.04 .51,.04 .43,.07
 * cat  M .19,.41 C .13,.28 .12,.12 .17,.08 C .22,.06 .32,.15 .38,.21
 *      C .46,.18 .55,.18 .63,.21 C .71,.12 .80,.06 .84,.09
 *      C .89,.14 .88,.30 .83,.42 C 1,.65 .85,.91 .66,.95
 *      C .54,.99 .41,.99 .30,.94 C .10,.88 .01,.64 .19,.41
 */
private val colors = mapOf(
    "mist" to listOf(0xFF8EAECD, 0xFFCEDDEC, 0xFFEEF4FA, 0xFFFFEAC5),
    "dusk" to listOf(0xFFCCAA91, 0xFFEAD2AB, 0xFFFCF0D4, 0xFFFFF6CF),
    "mint" to listOf(0xFF88B8B0, 0xFFC5E1D7, 0xFFEAF7EF, 0xFFFFECCE),
    "sakura" to listOf(0xFFC3A3BE, 0xFFEAD1DF, 0xFFFBEFF2, 0xFFFFF0D1),
)

private fun silhouette(shape: String) = Path().apply {
    when (shape) {
        "girl" -> {
            moveTo(.45f,.05f); cubicTo(.20f,.02f,.14f,.23f,.19f,.46f); cubicTo(.12f,.61f,.17f,.74f,.26f,.80f)
            cubicTo(.16f,.86f,.12f,.93f,.12f,.96f); cubicTo(.35f,1f,.72f,1f,.91f,.96f)
            cubicTo(.89f,.82f,.71f,.77f,.63f,.72f); cubicTo(.64f,.66f,.66f,.62f,.69f,.57f)
            cubicTo(.82f,.57f,.84f,.51f,.80f,.47f); cubicTo(.86f,.43f,.88f,.42f,.84f,.37f)
            cubicTo(.76f,.28f,.78f,.07f,.57f,.05f); cubicTo(.52f,.04f,.48f,.04f,.45f,.05f)
        }
        "boy" -> {
            moveTo(.43f,.07f); cubicTo(.20f,.08f,.16f,.27f,.24f,.42f); cubicTo(.19f,.52f,.23f,.66f,.35f,.70f)
            cubicTo(.35f,.77f,.24f,.79f,.17f,.86f); cubicTo(.12f,.90f,.10f,.94f,.10f,.97f)
            cubicTo(.38f,1f,.71f,1f,.93f,.96f); cubicTo(.89f,.81f,.72f,.76f,.63f,.72f)
            cubicTo(.64f,.66f,.65f,.63f,.69f,.58f); cubicTo(.79f,.58f,.84f,.54f,.80f,.49f)
            cubicTo(.87f,.47f,.88f,.44f,.83f,.39f); cubicTo(.74f,.32f,.79f,.20f,.68f,.12f)
            cubicTo(.61f,.04f,.51f,.04f,.43f,.07f)
        }
        "cat" -> {
            moveTo(.19f,.41f); cubicTo(.13f,.28f,.12f,.12f,.17f,.08f); cubicTo(.22f,.06f,.32f,.15f,.38f,.21f)
            cubicTo(.46f,.18f,.55f,.18f,.63f,.21f); cubicTo(.71f,.12f,.80f,.06f,.84f,.09f)
            cubicTo(.89f,.14f,.88f,.30f,.83f,.42f); cubicTo(1f,.65f,.85f,.91f,.66f,.95f)
            cubicTo(.54f,.99f,.41f,.99f,.30f,.94f); cubicTo(.10f,.88f,.01f,.64f,.19f,.41f)
        }
        else -> {
            moveTo(.50f,.06f); cubicTo(.22f,.03f,.08f,.28f,.12f,.55f); cubicTo(.15f,.84f,.40f,.99f,.66f,.89f)
            cubicTo(.92f,.80f,1f,.52f,.81f,.37f); cubicTo(.64f,.25f,.74f,.10f,.50f,.06f)
        }
    }; close()
}

@Composable
fun Avatar(size: Dp, modifier: Modifier = Modifier, choice: AvatarChoice = Appearance.choice.value) {
    Canvas(modifier.size(size)) {
        val palette = colors[choice.palette] ?: colors.getValue("mist")
        val width = this.size.width; val height = this.size.height
        val path = silhouette(choice.shape)
        withTransform({ scale(width, height, Offset.Zero) }) {
            clipPath(path) {
                drawRect(Brush.verticalGradient(0f to Color(palette[0]), .55f to Color(palette[1]), 1f to Color(palette[2]), endY = 1f), size = Size(1f,1f))
                drawCircle(Brush.radialGradient(listOf(Color(palette[3]).copy(alpha=.70f), Color.Transparent), Offset(.32f,.25f), .48f), .48f, Offset(.32f,.25f))
                drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha=.60f), Color.Transparent), Offset(.67f,.42f), .40f), .40f, Offset(.67f,.42f))
                listOf(floatArrayOf(-.15f,.60f,.80f,.20f,.45f),floatArrayOf(.30f,.52f,.80f,.22f,.50f),
                    floatArrayOf(-.08f,.72f,1.20f,.28f,.68f),floatArrayOf(.20f,.83f,.92f,.18f,.45f)).forEach { a ->
                    drawOval(Brush.verticalGradient(listOf(Color.White.copy(alpha=a[4]),Color.Transparent), a[1],a[1]+a[3]), Offset(a[0],a[1]), Size(a[2],a[3]))
                }
            }
        }
    }
}
