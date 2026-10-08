import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = f => readFileSync(new URL('../android/app/src/main/' + f, import.meta.url), 'utf8');
const pkg = 'java/io/github/yjw071218/ollamawebui/client/';
const main = src(pkg + 'MainActivity.java');
const manifest = src('AndroidManifest.xml');

test('other apps can share text, pictures and files into the app', () => {
  assert.match(manifest, /android\.intent\.action\.SEND"\/>[\s\S]{0,200}mimeType="\*\/\*"/);
  assert.match(manifest, /android\.intent\.action\.SEND_MULTIPLE"/);
  assert.match(manifest, /launchMode="singleTask"/, 'a share lands in the open app, not a second copy');
  assert.match(main, /Intent\.ACTION_SEND\.equals\(action\) \|\| Intent\.ACTION_SEND_MULTIPLE\.equals\(action\)/);
  assert.match(main, /"\{\\"type\\":\\"new-chat\\"\}"/);
  assert.match(main, /window\.__ollamaNative=window\.__ollamaNative\|\|\[\]\)\.push\(/, 'through the queue src/nativeEvents.js reads');
  assert.match(main, /SHARE_FILE_MAX = 20 \* 1024 \* 1024/);
});

test('a launcher shortcut opens a new chat', () => {
  assert.match(manifest, /android\.app\.shortcuts/);
  const shortcuts = src('res/xml/shortcuts.xml');
  assert.match(shortcuts, /io\.github\.yjw071218\.ollamawebui\.client\.NEW_CHAT/);
  assert.ok(main.includes('ACTION_NEW_CHAT = "io.github.yjw071218.ollamawebui.client.NEW_CHAT"'));
  assert.match(src('res/values-ko/strings.xml'), /새 대화/);
});

test('the microphone can be allowed for good, per server', () => {
  assert.match(main, /"always:media:" \+ p \+ ":" \+ server/);
  assert.match(main, /setNeutralButton\(L\.t\("항상 허용", "Always allow"\)[\s\S]{0,600}requestPermissions\(needed, MEDIA\)/);
  assert.match(main, /if \(remembered\) \{ requestPermissions\(needed, MEDIA\); return; \}/, 'Android itself still decides');
});

test('attaching offers the camera', () => {
  assert.match(main, /MediaStore\.ACTION_IMAGE_CAPTURE/);
  assert.match(main, /EXTRA_INITIAL_INTENTS/);
  assert.match(src('res/xml/share_paths.xml'), /name="camera" path="camera\/"/);
});

test('the network coming back reconnects on its own', () => {
  assert.match(manifest, /ACCESS_NETWORK_STATE/);
  assert.match(main, /registerDefaultNetworkCallback/);
  assert.match(main, /window\.__ollamaOffline&&location\.reload\(\)/);
  const proxy = src(pkg + 'LoopbackProxy.java');
  assert.match(proxy, /window\.__ollamaOffline=true/);
  assert.match(proxy, /if\(left<=0\)location\.reload\(\)/, 'and tries again every 15 seconds');
});

test('the screen stays on while an answer is written', () => {
  assert.match(src('assets/native.js'), /busy: value => \{ call\('busy'/);
  assert.match(main, /case "busy":[\s\S]{0,200}FLAG_KEEP_SCREEN_ON/);
});

test('recent servers, the phone theme and the phone language on the address screen', () => {
  assert.match(main, /private void rememberRecent\(String server\)/);
  assert.match(main, /setOnLongClickListener/);
  assert.match(main, /UI_MODE_NIGHT_YES/);
  assert.match(src(pkg + 'L.java'), /"ko"\.equals\(Locale\.getDefault\(\)\.getLanguage\(\)\)/);
  for (const f of ['MainActivity.java', 'UpdateDialog.java', 'CaptureService.java']) {
    const lines = src(pkg + f).split('\n').filter(l => /"[^"]*[가-힣][^"]*"/.test(l) && !/L\.t\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/safeName/.test(l));
    assert.deepEqual(lines, [], f + ' has Korean that is not translated');
  }
});

test('only <IPv4>.nip.io:<port> is taken, the server is asked first, and a site saved as one is dropped', () => {
  assert.match(main, /String rejected = migrateSaved\(\);/);
  assert.match(main, /private String migrateSaved\(\)[\s\S]{0,1500}edit\.remove\("server"\)/, 'a web site saved as the server is removed');
  assert.match(main, /edit\.putInt\("port:" \+ server, port\)/, 'an IP address saved before keeps its port, so its sign-in');
  assert.match(main, /try \{ LoopbackProxy\.probe\(server\); \}\s*catch \(LoopbackProxy\.NotServerException notServer\) \{ throw notServer; \}/);
  assert.match(main, /address\.setHint\(L\.t\("예: ", "e\.g\. "\) \+ LoopbackProxy\.EXAMPLE\);/);
  const proxy = src(pkg + 'LoopbackProxy.java');
  assert.match(proxy, /raw\.connect\(new InetSocketAddress\(addressOf\(target\.getHost\(\)\), port\), 15000\);/, 'no DNS needed for a nip.io name');
  assert.doesNotMatch(main, / \+ "\r?\n" \+ /, 'no string broken across lines');
});

test('a crashed WebView is replaced instead of ending the app', () => {
  assert.match(main, /public boolean onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\)[\s\S]{0,900}view\.destroy\(\);[\s\S]{0,400}else showWeb\(server\);\s*return true;/);
});

test('updates are checked again after six hours away, and pull down reloads', () => {
  assert.match(main, /onResume\(\)[\s\S]{0,200}UPDATE_EVERY\) checkUpdates\(false\)/);
  const js = src('assets/native.js');
  assert.match(js, /addEventListener\('touchstart'[\s\S]{0,200}passive: true/);
  assert.match(js, /if \(go\) location\.reload\(\)/);
  assert.match(js, /scrolledUp/);
});
