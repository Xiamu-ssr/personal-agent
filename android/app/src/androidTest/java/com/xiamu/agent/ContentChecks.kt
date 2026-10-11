package com.xiamu.agent

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.xiamu.agent.ui.siteMetadata
import com.xiamu.agent.connectors.connectionsFromJson
import com.xiamu.agent.connectors.AccountDraft
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ContentChecks {
    @Test fun briefsLoadCompleteHtmlDocumentsOnly() {
        val item = ReviewBriefs.items(java.time.LocalDate.now()).getJSONObject(0)
        val brief = BriefDocument.from(item)!!
        assertEquals(3, brief.cards.size)
        assertTrue(brief.cards.all { it.html.startsWith("<!doctype html>") })
        assertEquals(item.getJSONArray("cards").getJSONObject(0).getString("html"), brief.cards.first().html)
    }
    @Test fun briefInputRejectsRemovedJsonFormat() {
        assertNull(BriefDocument.from(JSONObject("""{"path":"data/briefs/today/晨报.json","brief":{"v":1,"cards":[{"title":"旧格式"}]}}""")))
    }
    @Test fun siteMetadataHandlesAttributeOrderAndEntities() {
        val metadata=siteMetadata("<TITLE>采购 &amp; 交期</TITLE><meta content='样品已到 &amp; 两项待确认' name='description'>","fallback")
        assertEquals("采购 & 交期",metadata.title); assertEquals("样品已到 & 两项待确认",metadata.description)
        assertEquals("站点名",siteMetadata("<html></html>","站点名").title)
    }
    @Test fun connectorParserOnlyListsInstalledAndCatalogAndSecretsStayMasked() {
        val json=JSONObject("""{"cloud":{"installed":[{"name":"qq-mail","fields":[{"key":"address","type":"text"},{"key":"password","type":"secret"}],"accounts":[{"id":"qq1","values":{"address":"fixture@qq.com","password":"••••"}}]}],"catalog":[]},"devices":[]}""")
        val data=connectionsFromJson(json,"local")
        assertEquals(1,data.connected.size)
        val connector=data.connected.first()
        val draft=AccountDraft(connector,true,connector.accounts.first())
        assertEquals("",draft.initial["password"])
        assertFalse(draft.payload(draft.initial).has("password"))
        assertFalse(draft.payload(draft.initial + ("password" to "••••")).has("password"))
    }
    @Test fun avatarIdsMatchV4ProfileContract() {
        assertEquals(setOf("bean","girl","boy","cat"),AvatarChoice.shapes.keys)
        assertEquals(setOf("mist","dusk","mint","sakura"),AvatarChoice.palettes.keys)
        assertEquals(AvatarChoice(),AvatarChoice.from(JSONObject().put("shape","unknown").put("palette","unknown")))
    }
}
