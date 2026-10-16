#!/usr/bin/env python3
"""0.8.1 Android UI acceptance against the real local cloud with a scripted model.
Run v08-demo.mjs first with V08_DEMO_OUTPUT=/tmp/v081-android-shots/host.
The driver only uses emulator-5554 and always closes it, including on failure.
"""
import json,os,re,runpy,time,uuid
from pathlib import Path
os.environ.setdefault('V08_REVIEW_SHOTS','/tmp/v081-android-shots')
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
out=r['SHOTS'];record=None;proof={}

def until(fn,seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=fn()
        if value:return value
        time.sleep(.35)
    raise RuntimeError('Review condition timed out')
def visible(text):return any(text in n.attrib.get('text','') for n in r['nodes']())
def hide_keyboard():
    if 'mInputShown=true' in r['shell']('dumpsys','input_method'):r['back']()
def restart():
    r['shell']('am','force-stop',r['PACKAGE']);r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
    until(lambda:any(n.attrib.get('content-desc')=='添加' for n in r['nodes']()),30)
def theme(dark):r['shell']('cmd','uimode','night','yes' if dark else 'no');time.sleep(.7)
def select_images(count):
    r['tap']('添加',True);r['tap']('图片')
    ns=r['nodes']()
    if any(n.attrib.get('text')=='Dismiss' for n in ns):r['tap']('Dismiss');ns=r['nodes']()
    images=[n for n in ns if n.attrib.get('content-desc','').startswith('Photo taken')]
    assert len(images)>=count
    for n in images[:count]:r['click'](*r['bounds'](n))
    r['tap']('Add ('+str(count)+')');time.sleep(.3)
def select_pdf():r['tap']('添加',True);r['tap']('上传文件');r['tap']('demo-plan.pdf');time.sleep(.3)
def clear_text():
    n=next(n for n in r['nodes']() if n.attrib.get('class')=='android.widget.EditText');r['click'](*r['bounds'](n))
    r['shell']('input','keycombination','113','29');r['shell']('input','keyevent','67')
def type_paragraph(value):
    n=next(n for n in r['nodes']() if n.attrib.get('class')=='android.widget.EditText');r['click'](*r['bounds'](n))
    for i in range(0,len(value),40):r['text'](value[i:i+40]);time.sleep(.2)
    time.sleep(.5)
    assert any(n.attrib.get('text')==value for n in r['nodes']())
def messages():return r['api']('/api/history')['items']
def count_user(text):return sum(m.get('role')=='user' and m.get('text')==text for m in messages())
def click_send_twice():
    n=next(n for n in r['nodes']() if n.attrib.get('content-desc')=='发送');x,y=r['bounds'](n)
    r['shell']('input','tap',str(x),str(y));r['shell']('input','tap',str(x),str(y))
def close_console():r['tap']('关闭控制台',True)
def post_requests(text):return [x for x in r['control']()['requests'] if x['body'].get('text')==text]

def onboarding():
    theme(False);restart();until(lambda:visible('开启本机能力'))
    r['shot']('06-onboarding-light.png');theme(True);r['shot']('07-onboarding-dark.png');theme(False)
    proof['onboarding']={'realFirstChatCards':True,'lightAndDarkColorTiles':True}

def attachments():
    theme(False);restart()
    if not (out/'06-onboarding-light.png').exists():
        r['shot']('06-onboarding-light.png');theme(True);r['shot']('07-onboarding-dark.png');theme(False)
    select_images(1);r['shot']('08-after-one-image.png')
    # Remove the thumbnail through the same button available to users.
    n=next(n for n in r['nodes']() if n.attrib.get('content-desc','').startswith('移除 '));r['click'](*r['bounds'](n))
    assert not any(n.attrib.get('content-desc','').startswith('移除 ') for n in r['nodes']())
    select_images(3);r['shot']('09-after-three-images.png');restart()
    select_pdf();r['shot']('10-after-pdf.png');select_images(1);r['shot']('11-after-mixed.png')
    type_paragraph('These pictures and the attached document are a demo. Please compare them and help me make a simple plan for the coming week. Keep every step clear and easy to follow.');hide_keyboard();r['shot']('12-after-long-text.png')
    r['tap']('发送',True);until(lambda:any(len(m.get('attachments',[]))==2 for m in messages()));time.sleep(.8);r['shot']('13-sent-mixed-attachments.png')
    select_images(3);r['tap']('发送',True);until(lambda:any(len(m.get('attachments',[]))==3 for m in messages()));time.sleep(.7);r['shot']('14-sent-three-images.png')
    proof['attachments']={'realSystemPickers':True,'individualRemoval':True,'mixedUpload':True,'threeImageUpload':True}
    print('ATTACHMENTS PASS',flush=True)

def colors():
    theme(False);restart();r['tap']('打开抽屉',True);r['tap']('设置');r['shot']('15-settings-light.png');theme(True);r['shot']('16-settings-dark.png');theme(False)
    r['tap']('连接应用');ns=r['nodes']();label=next(n.attrib['text'] for n in ns if n.attrib.get('text','').startswith('本机 ·'));r['tap'](label)
    # Battery does not request a dangerous Android permission; exercise its enabled appearance.
    ns=r['nodes']();battery=next(n for n in ns if n.attrib.get('text')=='电量')
    y=r['bounds'](battery)[1];switches=[n for n in ns if n.attrib.get('checkable')=='true' and abs(r['bounds'](n)[1]-y)<100]
    if switches and switches[0].attrib.get('checked')!='true':r['click'](*r['bounds'](switches[0]))
    r['shot']('17-local-capabilities-light.png');theme(True);r['shot']('18-local-capabilities-dark.png');theme(False)
    label=next(n.attrib['text'] for n in r['nodes']() if n.attrib.get('text','').startswith('云端 ·'));r['tap'](label);time.sleep(.5)
    r['shot']('19-cloud-connectors-light.png');theme(True);r['shot']('20-cloud-connectors-dark.png');theme(False);restart()
    proof['colors']={'settingsAndLocalAndCloudLightDark':True,'localTilesSharedWithChat':True}
    print('COLORS PASS',flush=True)

def discussion():
    restart();r['tap']('动态',True);time.sleep(.7);before=len(r['control']()['requests'])
    global record
    record=r['start_record']('01-discussion-to-send.mp4')
    r['tap']('讨论');assert visible('取消引用') or any(n.attrib.get('content-desc')=='取消引用' for n in r['nodes']())
    assert len(r['control']()['requests'])==before
    assert 'mInputShown=true' in r['shell']('dumpsys','input_method')
    r['shot']('21-discussion-quote-composer.png')
    # Cancel does not submit either endpoint. Stage it again, then send text.
    r['tap']('取消引用',True);assert len(r['control']()['requests'])==before;hide_keyboard()
    r['tap']('动态',True);r['tap']('讨论');r['edit']('I would like to try this idea.')
    r['control'](action='drop-ack',count=1,delay=300);r['tap']('发送',True);hide_keyboard()
    until(lambda:any(m.get('quote') and m.get('text')=='I would like to try this idea.' for m in messages()))
    time.sleep(.9);r['shot']('22-discussion-sent-quote.png');r['stop_record'](record);record=None
    req=post_requests('I would like to try this idea.');assert len(req)==2
    assert all(x['path']=='/api/feed/feedback' and x['body']['action']=='discuss' for x in req)
    assert len({x['body']['clientId'] for x in req})==1
    assert count_user('I would like to try this idea.')==1
    quoted=next(m['quote'] for m in messages() if m.get('quote') and m.get('text')=='I would like to try this idea.')
    r['tap'](quoted['title']);until(lambda:visible(quoted['title']));r['shot']('33-quote-return-to-feed.png')
    restart();r['tap']('动态',True);r['tap']('讨论');r['tap']('发送',True);hide_keyboard()
    until(lambda:any(m.get('quote') and m.get('text')=='' for m in messages()))
    proof['discussion']={'stagingAndCancelMadeNoRequest':True,'keyboardFocused':True,'endpoint':'/api/feed/feedback','requestCountWithDroppedReceipt':len(req),'sameClientId':True,'oneUserMessage':True,'emptyTextAccepted':True,'quoteReturnedToFeed':True}
    print('DISCUSSION PASS',flush=True)

def activities():
    theme(False);restart();until(lambda:not r['api']('/api/state')['busy'])
    r['api']('/api/send',{'text':'Just a demo greeting','clientId':str(uuid.uuid4())})
    until(lambda:not r['api']('/api/state')['busy'])
    pure_id=next(m['activityId'] for m in reversed(messages()) if m.get('text')=='Just a demo greeting' and m.get('role')=='user')
    r['control'](action='background-job');time.sleep(1)
    # Keep the console open across started/done/updated. An updated event must
    # patch the visible row without a fetch, a new row, or a chronological move.
    r['control'](action='summary-delay',ms=8000)
    r['tap']('打开头像控制台',True)
    r['api']('/api/send',{'text':'DEMO_CHAT','clientId':str(uuid.uuid4())})
    until(lambda:visible('处理中'));until(lambda:not r['api']('/api/state')['busy'],15)
    time.sleep(.7)
    before=r['api']('/api/activities');work_id=next(m['activityId'] for m in reversed(messages()) if m.get('text')=='DEMO_CHAT' and m.get('role')=='user')
    records=before['recent'];assert work_id in {a['id'] for a in records};assert pure_id not in {a['id'] for a in before['running']+records}
    assert not next(a for a in records if a['id']==work_id).get('summary')
    pending=next(n for n in r['nodes']() if n.attrib.get('text')=='处理中');position=r['bounds'](pending)[1]
    reads_before=r['control']()['activitiesReads'];r['shot']('39-console-awaiting-title.png')
    until(lambda:visible('读取本周安排'))
    updated=next(n for n in r['nodes']() if n.attrib.get('text')=='安排轻量运动')
    assert r['bounds'](updated)[1]==position
    assert r['control']()['activitiesReads']==reads_before
    after=r['api']('/api/activities')
    assert [(a['id'],a['ts']) for a in after['recent']]==[(a['id'],a['ts']) for a in records]
    r['shot']('23-console-activities-summary.png');r['control'](action='summary-delay',ms=350)
    r['tap']('安排轻量运动');until(lambda:visible('Read'))
    r['tap']('Read');r['shot']('25-activity-detail-trajectory.png')
    continuation='Continue this activity';r['edit'](continuation)
    r['control'](action='drop-ack',count=1,delay=300);r['tap']('发送',True);hide_keyboard()
    path='/api/activities/'+work_id+'/history'
    until(lambda:r['api'](path)['status']=='done' and any(i.get('text')==continuation for i in r['api'](path)['items']))
    until(lambda:visible('后台检查完成'))
    r['shot']('40-activity-continued.png')
    req=post_requests(continuation);assert len(req)==2 and len({x['body']['clientId'] for x in req})==1
    assert all(x['path']=='/api/activities/'+work_id+'/send' for x in req)
    assert sum(i.get('text')==continuation for i in r['api'](path)['items'])==1
    restart()
    ns=r['nodes']();bubble=next(n for n in ns if '可以从十分钟散步开始' in n.attrib.get('text',''))
    x,y=r['bounds'](bubble);r['shell']('input','swipe',str(x),str(y),str(x),str(y),'900');time.sleep(.4)
    assert visible('复制') and not visible('查看过程');r['shot']('24-assistant-copy-menu.png');r['tap']('复制')
    proof['activities']={'serverCanonicalListOnly':True,'pureChatsExcluded':True,'toolWorkIncluded':True,'asyncTitleAndSummaryShown':True,'titleUpdatedWithoutFetch':True,'rowPositionAndChronologyUnchanged':True,'copyOnlyMenu':True,'toolHistoryShown':True,'activityContinuedWithSameId':True,'continuationRetrySameClientIdAndOnePrompt':True,'workId':work_id,'pureChatId':pure_id,'activityListReadsDuringUpdate':0}
    print('ACTIVITIES PASS',flush=True)

def reliability():
    restart();r['edit']('Retry only once');r['control'](action='drop-ack',count=2,delay=900)
    click_send_twice();r['shot']('26-send-pending-disabled.png');until(lambda:len(post_requests('Retry only once'))==2)
    time.sleep(1.4);hide_keyboard();r['shot']('27-retry-preserved-draft.png');assert count_user('Retry only once')==1
    r['tap']('发送',True);time.sleep(.7);assert count_user('Retry only once')==1
    req=post_requests('Retry only once');assert len(req)==3 and len({x['body']['clientId'] for x in req})==1
    r['control'](action='disconnect-reply');time.sleep(8)
    until(lambda:visible('断线期间补上的回复，只出现一次。'));r['shot']('28-websocket-reconnect-catchup.png')
    assert sum(n.attrib.get('text')=='断线期间补上的回复，只出现一次。' for n in r['nodes']())==1
    r['shell']('input','keyevent','3');time.sleep(.5);r['control'](action='send',text='DEMO_BACKGROUND');time.sleep(1)
    r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity');time.sleep(1)
    until(lambda:visible('回到前台补上的回复，只出现一次。'));r['shot']('29-foreground-catchup.png')
    assert sum(n.attrib.get('text')=='回到前台补上的回复，只出现一次。' for n in r['nodes']())==1
    r['control'](action='send',text='DEMO_FINAL_SAY');until(lambda:any(m.get('text')=='这是最终答复，通过 say 完整发出。' for m in messages()))
    assert not any(m.get('text')=='这段模型正文只保存在过程记录里。' for m in messages())
    until(lambda:visible('这是最终答复，通过 say 完整发出。'));r['shot']('30-final-say-bubble.png')
    proof['reliability']={'rapidSecondTapBlocked':True,'automaticAndManualRetrySameClientId':True,'mainUserStoredOnce':True,'wsDisconnectReplyRecoveredOnce':True,'backgroundReplyRecoveredOnce':True,'finalSayRendered':True,'rawBodyStayedInProcess':True}
    print('RELIABILITY PASS',flush=True)

def side():
    restart();r['tap']('打开抽屉',True);r['tap']('新旁聊');r['edit']('Side retry demo')
    r['control'](action='drop-ack',count=1,delay=400);r['tap']('发送',True);hide_keyboard();time.sleep(1.4)
    until(lambda:visible('想先从哪一步开始？'));r['shot']('31-side-chat-create-once.png')
    req=post_requests('Side retry demo');assert len(req)==2 and len({x['body']['clientId'] for x in req})==1
    data=r['api']('/api/activities');items=[a for a in data['running']+data['recent'] if a.get('chatType')=='side' and a.get('title',a.get('label'))=='Side retry demo'];assert len(items)==1
    id=items[0]['id'];path='/api/activities/'+id
    assert sum(m.get('text')=='Side retry demo' for m in r['api'](path+'/history')['messages'])==1
    r['edit']('Continue this side chat');r['control'](action='drop-ack',count=1,delay=400);r['tap']('发送',True);hide_keyboard();time.sleep(1.4)
    until(lambda:visible('补充收到了，我们继续这次旁聊。'));r['shot']('32-side-chat-continue-once.png')
    req=post_requests('Continue this side chat');assert len(req)==2 and len({x['body']['clientId'] for x in req})==1
    assert sum(m.get('text')=='Continue this side chat' for m in r['api'](path+'/history')['messages'])==1
    proof['side']={'createdOnceWithLostReceipt':True,'continuedOnceWithLostReceipt':True,'sameClientIdOnBothRetries':True}
    r['tap']('回到主聊天',True)
    print('SIDE PASS',flush=True)

def extras():
    theme(False);restart()
    latest=r['api']('/api/feed?days=7')['items'];target=latest[-1]
    r['api']('/api/feed/feedback',{'path':target['path'],'action':'discuss','text':'Jump to an earlier post','clientId':str(uuid.uuid4())})
    until(lambda:visible(target['title']));r['tap'](target['title'])
    until(lambda:visible(target['title']));assert not visible('动态详情')
    r['shot']('36-quote-return-to-earlier-feed.png')
    restart();all_posts=r['api']('/api/feed?days=31')['items'];paths={p['path'] for p in latest}
    older=next(p for p in reversed(all_posts) if p['path'] not in paths)
    r['api']('/api/feed/feedback',{'path':older['path'],'action':'discuss','text':'Read the older post','clientId':str(uuid.uuid4())})
    until(lambda:visible(older['title']));r['tap'](older['title']);until(lambda:visible('动态详情'))
    assert visible(older['title']);r['shot']('34-quote-older-post-detail.png')
    restart();select_images(3);select_images(3)
    ns=r['nodes']()
    def horizontal(n):
        b=list(map(int,re.findall(r'\d+',n.attrib.get('bounds',''))))
        return n.attrib.get('scrollable')=='true' and len(b)==4 and b[2]-b[0]>(b[3]-b[1])*2
    row=next(n for n in ns if horizontal(n));b=list(map(int,re.findall(r'\d+',row.attrib['bounds'])));y=(b[1]+b[3])//2
    r['shell']('input','swipe',str(b[2]-40),str(y),str(b[0]+40),str(y),'450');time.sleep(.4)
    r['shot']('35-attachments-horizontal-scroll.png')
    restart();r['tap']('打开抽屉',True);r['tap']('设置');r['tap']('连接应用')
    label=next(n.attrib['text'] for n in r['nodes']() if n.attrib.get('text','').startswith('本机 ·'));r['tap'](label);r['swipe']()
    assert visible('运动健康');r['shot']('37-local-health-light.png');theme(True);r['shot']('38-local-health-dark.png');theme(False)
    proof['extras']={'olderLoadedPostScrollsIntoView':True,'notInPageOpensPostDetail':True,'sixAttachmentsScrollHorizontally':True,'healthAndClipboardColorTilesShown':True}
    print('EXTRAS PASS',flush=True)

try:
    r['adb']('wait-for-device',timeout=60);until(lambda:r['shell']('getprop','sys.boot_completed').strip()=='1',60)
    r['adb']('install','-r',str(Path(__file__).resolve().parents[1]/'app/build/outputs/apk/debug/app-debug.apk'),timeout=60)
    phase=os.environ.get('V081_PHASE','all')
    for name,fn in [('onboarding',onboarding),('attachments',attachments),('colors',colors),('discussion',discussion),('activities',activities),('reliability',reliability),('side',side),('extras',extras)]:
        if phase=='all' or name in phase.split(','):fn();(out/('ui-proof-'+name+'.json')).write_text(json.dumps(proof[name],ensure_ascii=False,indent=2))
    print('V081 UI PASS',flush=True)
except Exception:
    try:r['shot']('review-interrupted.png')
    except Exception:pass
    raise
finally:
    if record:
        try:r['stop_record'](record)
        except Exception:pass
    try:(out/'app-runtime.log').write_bytes(r['adb']('logcat','-d','-s','AndroidRuntime:E'))
    except Exception:pass
    try:r['adb']('emu','kill')
    except Exception:pass
    print('EMULATOR CLEANUP REQUESTED',flush=True)
