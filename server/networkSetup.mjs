import { isIP } from 'node:net';
export function publicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a,b,c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && [18,19,51].includes(b)) ||
    (a === 203 && b === 0 && c === 113));
}
export async function networkSetup({env, readEnvValue, save, ask, yes, log=console.log, writeGuide=()=>{}}) {
  const port = readEnvValue(env(), 'PORT') || '5173';
  log('외부망 접속 설정 (공유기는 직접 설정하며, Windows 방화벽은 별도 관리자 승인 후 설정합니다)');
  log('HTTP는 비밀번호·대화를 암호화하지 않습니다. 외부 공개에는 HTTPS 또는 VPN을 권장합니다.');
  if (!await yes('인터넷 외부망에서도 이 서버에 접속하도록 설정할까요?')) {
    save('EXTERNAL_ACCESS', '0');
    save('PUBLIC_ORIGIN', 'http://localhost:' + port);
    log('외부망 주소를 사용하지 않습니다. 기존 공유기 포트포워딩은 직접 해제해야 합니다.');
    return;
  }
  let ip = '';
  while (!ip) {
    const answer = await ask('공유기 관리 화면의 WAN 공인 IPv4 (Enter = 외부망 설정 취소): ');
    if (!answer) { log('외부망 설정을 변경하지 않았습니다.'); return; }
    if (publicIPv4(answer)) ip = answer;
    else log('유효한 공인 IPv4를 입력하세요. 사설 IP·CGNAT 주소는 직접 포트포워딩할 수 없습니다.');
  }
  const origin = 'http://' + ip + '.nip.io:' + port;
  save('HOST', '0.0.0.0'); save('EXTERNAL_ACCESS','1'); save('PUBLIC_ORIGIN',origin);
  const guide = [
    '외부망 접속 주소: ' + origin,
    '1. Windows ipconfig / macOS·Linux 네트워크 설정에서 서버 PC의 LAN IPv4와 기본 게이트웨이를 확인합니다.',
    '2. 기본 게이트웨이 주소를 브라우저로 열어 공유기 관리자로 로그인합니다.',
    '3. DHCP 주소 예약에서 서버 PC의 LAN IPv4가 바뀌지 않도록 예약합니다.',
    '4. NAT/포트포워딩 메뉴: TCP, 외부 포트 ' + port + ', 내부 IP = 서버 PC의 LAN IPv4, 내부 포트 ' + port + '.',
    '5. OS 방화벽에서 필요한 네트워크에만 해당 TCP 포트를 허용합니다. 방화벽 전체 해제나 DMZ는 사용하지 마세요.',
    '6. 휴대폰 Wi-Fi를 끄고 이동통신으로 위 주소에 접속합니다. 접속 토큰을 타인에게 공개하지 마세요.',
    '7. 공유기 WAN 주소가 사설 IP 또는 100.64.0.0/10이면 이중 NAT/CGNAT일 수 있습니다. 상위 공유기 설정 또는 통신사 공인 IP/VPN이 필요합니다.',
    '8. 집 안에서만 공인 주소가 안 열리면 공유기의 NAT loopback 미지원일 수 있습니다. LAN 주소로 확인하세요.',
    '9. 공인 IP가 바뀌면 PUBLIC_ORIGIN과 Google·카카오 콘솔의 주소도 갱신해야 합니다.',
    'nip.io는 DNS만 제공합니다. HTTPS나 포트포워딩을 대신하지 않으며 IP를 숨기지 않습니다.',
    '프로그램을 다시 실행하면 PUBLIC_ORIGIN 주소를 기본 브라우저로 엽니다. 개방 성공 여부를 보장하지 않습니다.'
  ].join('\n');
  log(guide); writeGuide(guide);
}
