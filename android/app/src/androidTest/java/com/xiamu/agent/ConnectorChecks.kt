package com.xiamu.agent

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.connectors.AccountDraft
import com.xiamu.agent.connectors.connectorInfo
import com.xiamu.agent.ui.Nav
import com.xiamu.agent.ui.Route
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConnectorChecks {
    @get:Rule val compose = createEmptyComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun review(scenario: String, block: (ActivityScenario<ConnectorReviewActivity>) -> Unit) {
        ActivityScenario.launch<ConnectorReviewActivity>(Intent(context, ConnectorReviewActivity::class.java).putExtra("scenario", scenario)).use {
            compose.waitForIdle()
            assertFalse(Prefs.configured)
            block(it)
        }
    }

    @Test fun catalogOpensDetailAndCustomIsReadOnly() = review("cloud") { activity ->
        compose.onNodeWithText("豆豆自建").assertExists()
        compose.onNodeWithText("连接").performClick()
        compose.onNodeWithText("还没有添加账号").assertExists()
        activity.onActivity { assertTrue(Nav.stack.last() is Route.ConnectorDetail); assertEquals(0, it.gateway.saves) }
    }

    @Test fun oldCatalogWithoutFieldsFallsBack() = review("legacy") { activity ->
        compose.onNodeWithText("即将支持").performClick()
        compose.onAllNodesWithText("账号表单即将支持").assertCountEquals(2)
        compose.onNodeWithText("添加账号").assertDoesNotExist()
        activity.onActivity { assertEquals(0, it.gateway.saves) }
    }

    @Test fun multipleAccountsAndRetestRefresh() = review("detail-multi") { activity ->
        compose.onNodeWithText("个人 QQ 邮箱").assertExists()
        compose.onNodeWithText("工作 163 邮箱").assertExists()
        compose.onNodeWithText("授权码不对或没开 IMAP", substring = true).assertExists()
        compose.onAllNodesWithText("重新测试").assertCountEquals(2)
        compose.onAllNodesWithText("重新测试").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("连接异常").fetchSemanticsNodes().isEmpty() }
        compose.onAllNodesWithText("已连接").assertCountEquals(2)
        activity.onActivity { assertEquals(1, it.gateway.tests) }
    }

    @Test fun presetHelpVisibilityDefaultAndBothSelectStyles() = review("form-default") { activity ->
        compose.onNodeWithTag("field:host").assertDoesNotExist()
        compose.onNodeWithText("QQ 邮箱网页版", substring = true).assertExists()
        compose.onNodeWithTag("field:preset").performClick()
        compose.onNodeWithText("其他（手动填服务器）").performClick()
        compose.onNodeWithTag("field:host").assertExists()
        compose.onNodeWithTag("field:port").assertTextEquals("993")
        compose.onNodeWithText("在邮箱服务商设置中开启 IMAP", substring = true).assertExists()
        compose.onNodeWithText("QQ 邮箱网页版", substring = true).assertDoesNotExist()
        compose.onNodeWithText("常用文件夹").performScrollTo().performClick()
        activity.onActivity {
            val connector = runBlocking { it.gateway.list() }.connector("email")!!
            val draft = AccountDraft(connector, false)
            val values = draft.initial + mapOf("preset" to "custom", "host" to "imap.example.com", "scope" to "common")
            val payload = draft.payload(values)
            assertEquals(993, payload.getInt("port"))
            assertEquals("common", payload.getString("scope"))
        }
    }

    @Test fun addingAccountReturnsToRefreshedListAndOmitsHiddenFields() = review("form-default") { activity ->
        compose.onNodeWithTag("field:address").performTextInput("local@qq.com")
        compose.onNodeWithTag("field:password").performTextInput("fixture-code")
        compose.onNodeWithText("验证并添加").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("重新测试").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("local@qq.com").assertExists()
        activity.onActivity {
            assertTrue(Nav.stack.last() is Route.ConnectorDetail)
            assertEquals(1, it.gateway.saves)
            assertEquals("qq", it.gateway.lastValues!!.getString("preset"))
            assertFalse(it.gateway.lastValues!!.has("host"))
            assertFalse(it.gateway.lastValues!!.has("port"))
            assertFalse(it.gateway.lastValues!!.has("scope"))
        }
    }

    @Test fun failedValidationPreservesEnteredValues() = review("form-failed") { activity ->
        compose.onNodeWithText("验证并添加").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("授权码不对，请重新生成后再试").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("field:address").assertTextEquals("fixture@qq.com")
        compose.onNodeWithContentDescription("显示授权码").performClick()
        compose.onNodeWithTag("field:password").assertTextEquals("fixture-invalid")
        compose.onNodeWithContentDescription("隐藏授权码").performClick()
        activity.onActivity { assertTrue(Nav.stack.last() is Route.ConnectorForm); assertEquals(1, it.gateway.saves) }
    }

    @Test fun submittingBlocksRepeatTaps() = review("form-validating") { activity ->
        compose.onNodeWithText("验证并添加").performClick()
        compose.onNodeWithText("正在验证…").assertIsNotEnabled().performTouchInput { click(); click() }
        activity.onActivity { assertEquals(1, it.gateway.saves) }
    }

    @Test fun editingPrefillsValuesAndOmitsBlankSecret() = review("form-edit") { activity ->
        compose.onNodeWithText("QQ 邮箱").assertExists()
        compose.onNodeWithTag("field:address").assertTextEquals("fixture@qq.com")
        compose.onNodeWithText("不修改请留空").assertExists()
        compose.onNodeWithContentDescription("显示授权码").performClick()
        assertEquals("", compose.onNodeWithTag("field:password").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithTag("field:host").assertDoesNotExist()
        compose.onNodeWithTag("field:label").performScrollTo().assertTextEquals("个人 QQ 邮箱").performTextReplacement("个人邮箱")
        compose.onNodeWithText("保存并验证").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("重新测试").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("个人邮箱").assertExists()
        activity.onActivity {
            assertEquals("qq1", it.gateway.lastEditedId)
            val values = it.gateway.lastValues!!
            assertEquals(setOf("preset", "address", "label"), values.keys().asSequence().toSet())
            assertEquals("qq", values.getString("preset"))
            assertEquals("fixture@qq.com", values.getString("address"))
            assertEquals("个人邮箱", values.getString("label"))
            val account = runBlocking { it.gateway.list() }.connector("email")!!.accounts.first()
            val saved = account.values!!
            assertEquals("••••", saved["password"])
            assertEquals("个人邮箱", saved["label"])
        }
    }

    @Test fun customEditPrefillsConditionalFieldsAndSavedPort() = review("form-edit-custom") { activity ->
        compose.onNodeWithText("其他（手动填服务器）").assertExists()
        compose.onNodeWithTag("field:address").assertTextEquals("fixture@example.com")
        compose.onNodeWithText("不修改请留空").assertExists()
        compose.onNodeWithTag("field:host").assertTextEquals("imap.example.com")
        compose.onNodeWithTag("field:port").performScrollTo().assertTextEquals("1993")
        compose.onNodeWithTag("field:label").performScrollTo().assertTextEquals("工作邮箱").performTextReplacement("")
        compose.onNodeWithText("保存并验证").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("重新测试").fetchSemanticsNodes().isNotEmpty() }
        activity.onActivity {
            assertEquals("custom1", it.gateway.lastEditedId)
            val values = it.gateway.lastValues!!
            assertEquals("custom", values.getString("preset"))
            assertEquals("imap.example.com", values.getString("host"))
            assertEquals(1993, values.getInt("port"))
            assertEquals("common", values.getString("scope"))
            assertEquals("", values.getString("label"))
            assertFalse(values.has("password"))
        }
    }

    @Test fun nullAccountValuesKeepLegacyPartialUpdates() {
        val json = JSONObject(context.assets.open("connectors.json").bufferedReader().use { it.readText() }).getJSONObject("cloud").getJSONArray("catalog").getJSONObject(0)
        json.put("accounts", org.json.JSONArray().put(JSONObject().put("id", "old").put("values", JSONObject.NULL)))
        val connector = connectorInfo(json)
        val account = connector.accounts.first()
        assertNull(account.values)
        val draft = AccountDraft(connector, true, account)
        assertTrue(draft.partialEdit)
        assertTrue(draft.initial.values.all { it.isEmpty() })
        assertEquals(setOf("label"), draft.payload(draft.initial + ("label" to "Work")).keys().asSequence().toSet())
    }

    @Test fun editingIsPartialAndKeepsBlankOrMaskedSecrets() = review("form-edit-legacy") { activity ->
        assertEquals("", compose.onNodeWithTag("field:address").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithText("不修改请留空").assertExists()
        compose.onNodeWithTag("field:label").performScrollTo().performTextInput("Work")
        compose.onNodeWithText("保存并验证").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("Work").fetchSemanticsNodes().isNotEmpty() }
        activity.onActivity {
            assertEquals("qq1", it.gateway.lastEditedId)
            assertEquals(setOf("label"), it.gateway.lastValues!!.keys().asSequence().toSet())
            val connector = runBlocking { it.gateway.list() }.connector("email")!!
            val draft = AccountDraft(connector, true)
            assertFalse(draft.payload(draft.initial + ("password" to "••••")).has("password"))
        }
    }

    @Test fun deletingRequiresConfirmationAndRefreshes() = review("detail-multi") { activity ->
        compose.onAllNodesWithText("删除").onFirst().performClick()
        compose.onNodeWithText("删除账号").assertExists()
        compose.onNodeWithText("取消").performClick()
        activity.onActivity { assertEquals(0, it.gateway.deletions) }
        compose.onAllNodesWithText("删除").onFirst().performClick()
        compose.onAllNodesWithText("删除").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("个人 QQ 邮箱").fetchSemanticsNodes().isEmpty() }
        activity.onActivity { assertEquals(1, it.gateway.deletions) }
    }

    @Test fun onlyOfflineDeviceCanBeRemovedAndNeedsConfirmation() = review("devices") { activity ->
        compose.onAllNodesWithText("移除").assertCountEquals(1)
        compose.onNodeWithText("移除").performClick()
        compose.onNodeWithText("移除设备").assertExists()
        compose.onNodeWithText("取消").performClick()
        activity.onActivity { assertEquals(0, it.gateway.removals) }
        compose.onNodeWithText("移除").performClick()
        compose.onAllNodesWithText("移除").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("旧笔记本").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("工作电脑").assertExists()
        compose.onNodeWithText("移除").assertDoesNotExist()
        activity.onActivity { assertEquals(1, it.gateway.removals) }
    }

    @Test fun deviceOnlineConflictIsExplainedAndCannotBeRetried() = review("devices-conflict") { activity ->
        compose.onNodeWithText("移除").performClick()
        compose.onAllNodesWithText("移除").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("设备在线，不能移除").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("移除").assertIsNotEnabled()
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithText("移除").assertDoesNotExist()
        activity.onActivity { assertEquals(1, it.gateway.removals) }
    }
}
