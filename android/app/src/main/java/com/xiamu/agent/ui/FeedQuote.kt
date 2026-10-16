package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import com.xiamu.agent.FeedQuote

@Composable
fun FeedQuoteCard(quote: FeedQuote, modifier: Modifier = Modifier, onCancel: (() -> Unit)? = null, onOpen: (() -> Unit)? = null) {
    Row(modifier.clip(RoundedCornerShape(14.dp)).background(Pal.Quiet)
        .then(if(onOpen!=null) Modifier.tap(onClick=onOpen) else Modifier).padding(start=12.dp,end=6.dp,top=10.dp,bottom=10.dp),
        verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
        Text(quote.emoji.ifBlank { "📰" },fontSize=23.sp)
        Column(Modifier.weight(1f)) {
            Text(quote.title,style=Type.title(13),color=Pal.Ink,maxLines=2,overflow=TextOverflow.Ellipsis)
            if(quote.source.isNotBlank()) Text(quote.source,style=Type.body(11),color=Pal.Muted,maxLines=1,overflow=TextOverflow.Ellipsis)
        }
        if(onCancel!=null) Box(Modifier.size(32.dp).tap(onClick=onCancel),contentAlignment=Alignment.Center) {
            Icon(Icons.Outlined.Close,"取消引用",tint=Pal.Muted,modifier=Modifier.size(18.dp))
        }
    }
}

@Composable
fun FeedDetailScreen(quote: FeedQuote) {
    val (post,error)=load("feed-item:${quote.path}",cacheValue=false) { Api.feedItem(quote.path) }
    SubPage("动态详情") {
        if(post!=null) item { FeedPostView(post) }
        else if(error.isBlank()) item { Loading() }
        else item { FeedQuoteCard(quote,Modifier.fillMaxWidth()); ErrorNote(error) }
    }
}
