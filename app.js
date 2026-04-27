// ══════════════════════════════════════════════
//  VOICE ANALYZER  (iOS Safari対応版)
// ══════════════════════════════════════════════
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;

class VoiceAnalyzer{
  constructor(){this.ctx=null;this.analyser=null;this.stream=null;this.recording=false;this.pitchSamples=[];this.spectralAccum=null;this.spectralCount=0;this.FFT=2048;this.SR=44100;this._iv=null}

  async start(){
    // Step1: マイク取得 — iOSは厳密制約を拒否するのでフォールバック付き
    try{
      this.stream=await navigator.mediaDevices.getUserMedia(
        {audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    }catch(e){
      try{this.stream=await navigator.mediaDevices.getUserMedia({audio:true});}
      catch(e2){throw new Error('microphone_denied');}
    }
    // Step2: AudioContext (webkitAudioContext iOS対応)
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    this.ctx=new AudioCtx();
    this.SR=this.ctx.sampleRate;
    // Step3: iOS必須 — suspended状態をresumeする
    if(this.ctx.state==='suspended') await this.ctx.resume();
    // Step4: 解析グラフ接続
    const src=this.ctx.createMediaStreamSource(this.stream);
    this.analyser=this.ctx.createAnalyser();
    this.analyser.fftSize=this.FFT;
    this.analyser.smoothingTimeConstant=0.15;
    src.connect(this.analyser);
    this.recording=true;this.pitchSamples=[];
    this.spectralAccum=new Float32Array(this.FFT/2);this.spectralCount=0;
    this._iv=setInterval(()=>this._tick(),80);
  }
  _tick(){
    if(!this.recording)return;
    const td=new Float32Array(this.FFT),fd=new Uint8Array(this.FFT/2);
    this.analyser.getFloatTimeDomainData(td);this.analyser.getByteFrequencyData(fd);
    const p=this._pitch(td);if(p)this.pitchSamples.push(p);
    for(let i=0;i<fd.length;i++)this.spectralAccum[i]+=fd[i];this.spectralCount++;
  }
  _pitch(buf){
    const N=buf.length;let rms=0;for(let i=0;i<N;i++)rms+=buf[i]*buf[i];rms=Math.sqrt(rms/N);
    if(rms<0.006)return null; // iOSは感度が低いため閾値を下げる
    const minL=Math.round(this.SR/800),maxL=Math.round(this.SR/50);
    const r0=rms*rms*N; // Fix F: reuse already-computed sum of squares
    let best=-1,bestC=-Infinity;
    for(let lag=minL;lag<=Math.min(maxL,N/2-1);lag++){let c=0;for(let i=0;i<N-lag;i++)c+=buf[i]*buf[i+lag];if(c>bestC){bestC=c;best=lag;}}
    if(best<0||bestC<r0*0.38)return null;
    const f=this.SR/best;return(f>=55&&f<=750)?f:null;
  }
  timeDomain(){if(!this.analyser)return null;const d=new Float32Array(this.FFT);this.analyser.getFloatTimeDomainData(d);return d}
  stop(){
    this.recording=false;clearInterval(this._iv);
    if(this.stream)this.stream.getTracks().forEach(t=>t.stop());
    // Fix D: close AudioContext to free iOS resources (limit: 6 concurrent)
    if(this.ctx&&this.ctx.state!=='closed'){this.ctx.close().catch(()=>{});}
    this.ctx=null;this.analyser=null;this.stream=null;
    if(!this.spectralCount)return null;
    const avg=new Float32Array(this.spectralAccum.length);
    for(let i=0;i<avg.length;i++)avg[i]=this.spectralAccum[i]/this.spectralCount;
    return this._metrics(avg);
  }
  _metrics(sp){
    const vp=this.pitchSamples.filter(p=>p>=55&&p<=750);
    let medPitch=null,stability=0,pitchRange=0,minPitch=null,maxPitch=null;
    if(vp.length>=3){
      const s=[...vp].sort((a,b)=>a-b);medPitch=s[Math.floor(s.length/2)];
      minPitch=s[Math.round(s.length*0.05)];  // 5th percentile (ignore outliers)
      maxPitch=s[Math.round(s.length*0.95)-1]; // 95th percentile
      const mu=vp.reduce((a,v)=>a+v,0)/vp.length;
      const std=Math.sqrt(vp.reduce((a,v)=>a+(v-mu)**2,0)/vp.length);
      stability=Math.max(0,Math.min(1,1-(std/mu)*3.5));pitchRange=maxPitch-minPitch;
    }
    const bHz=this.SR/this.FFT;let wSum=0,totMag=0;
    for(let i=1;i<sp.length;i++){wSum+=sp[i]*i*bHz;totMag+=sp[i];}
    const centroid=totMag>0?wSum/totMag:1500;
    const lowBin=Math.round(450/bHz);let lowE=0,totE=1e-6;
    for(let i=1;i<sp.length;i++){const e=sp[i]**2;if(i<=lowBin)lowE+=e;totE+=e;}
    const warmth=lowE/totE;
    const hiBin=Math.round(2500/bHz);let hiE=0;for(let i=hiBin;i<sp.length;i++)hiE+=sp[i]**2;
    const brightness=hiE/totE;
    const hnr=medPitch?this._hnr(sp,medPitch):50;
    return{medPitch,minPitch,maxPitch,stability,pitchRange,centroid,warmth,brightness,hnr,n:vp.length};
  }
  _hnr(sp,f0){
    const bHz=this.SR/this.FFT,f0b=f0/bHz;let hE=0,nE=1e-4;
    for(let h=1;h<=10;h++){
      const hb=Math.round(h*f0b);if(hb>=sp.length-3)break;
      for(let b=Math.max(1,hb-2);b<=Math.min(sp.length-1,hb+2);b++)hE+=sp[b]**2;
      if(h<10){const mb=Math.round((h+0.5)*f0b);if(mb<sp.length-2)for(let b=Math.max(1,mb-2);b<=Math.min(sp.length-1,mb+2);b++)nE+=sp[b]**2;}
    }
    return Math.min(100,Math.max(0,(Math.log10(hE/nE+1)/2.5)*100));
  }
}

// ══════════════════════════════════════════════
//  SUBTYPE
// ══════════════════════════════════════════════
function getSubType(m){
  if(!m)return'standard';
  const warm=m.warmth>0.26,bright=m.brightness>0.065||m.centroid>1850,clear=m.hnr>68;
  if(warm&&!bright)return'warm';
  if(bright&&!warm)return'bright';
  if(clear)return'clear';
  return'standard';
}
function subTypeLabel(st){
  return{warm:'温かみ系 — 低域豊富・柔らかな響き',bright:'輝き系 — 高域際立つ・シャープな響き',clear:'澄み系 — 倍音が整った透明な声',standard:'バランス系 — 標準的な音色バランス'}[st]||'バランス系';
}

// ══════════════════════════════════════════════
//  VOICE PROFILES (9 bands)
//  refs: { va/singer/actor/narrator: { warm/bright/clear/standard: [{n,r,note,gender}] } }
//  gender: 'm'=男性 'f'=女性 'mf'=両性共通

// ══════════════════════════════════════════════
//  SLIM PROFILES — archetype descriptions only
// ══════════════════════════════════════════════
const PROFILES=[
  {f0:[55,88],arch:'バス型',gender:'m',desc:'最も低く重厚な声域。圧倒的な存在感と安心感を持ち、ナレーション・ドラマ的語りで説得力を発揮する。',tip:'低音の重厚感を活かしつつ、<strong>滑舌と母音の明瞭な開き</strong>を意識すると聴き取りやすさが大幅に向上する。'},
  {f0:[88,118],arch:'バス・バリトン型',gender:'m',desc:'重低音の迫力を保ちながら、バリトンの温かみと表情が加わった声域。深みと表現力が共存する。',tip:'<strong>口を縦に大きく開ける</strong>発声を意識すると、低音の豊かさをそのままに聴き取りやすさが増す。'},
  {f0:[118,138],arch:'低バリトン型',gender:'m',desc:'深みと温かみを兼ね備えた男声の主流声域。日本で最も「渋い・いい声」と評されやすい音域。信頼感と包容力を自然に演出する。',tip:'<strong>腹式呼吸の安定</strong>と<strong>言葉の前の「溜め」（間）</strong>を意識すると説得力が大幅に増す。'},
  {f0:[138,162],arch:'高バリトン型',gender:'m',desc:'バリトンの深みを保ちながらテノールの明るさが加わる声域。色気・爽やかさ・信頼感を同時に持ち、幅広い表現が可能。',tip:'<strong>チェストボイスとミックスボイスの切り替え</strong>を磨くことで表現の幅が格段に拡大する。'},
  {f0:[162,200],arch:'テノール型',gender:'m',desc:'明瞭で聞き取りやすい男声の高域。高音まで伸びやかに発声できる可能性があり、歌声での表現力が特に豊か。',tip:'<strong>ロングトーンの安定性</strong>と<strong>高音での支え（腹式呼吸）</strong>を磨くと、声の可能性が大きく広がる。'},
  {f0:[200,235],arch:'ハイテノール / コントラルト型',gender:'mf',desc:'男声の最高域テノールと、女声の最も落ち着いたコントラルトが交わる声域。男性では希少なハイテノール、女性では深みと落ち着きが共存するコントラルト。両性それぞれで強い個性と表現力を持つ。',tip:'男性なら<strong>高音域の支え（腹式呼吸）</strong>を、女性なら<strong>低域共鳴（胸声）の安定</strong>を磨くと、この声域の魅力を最大限に活かせる。'},
  {f0:[235,272],arch:'メゾアルト型',gender:'f',desc:'落ち着きと深みを持ちながらクリアさも兼ね備えた女声の中間域。大人の品格と親しみやすさが共存し、幅広い場面で映える。',tip:'<strong>ミックスボイスの習得</strong>で、深みとクリアさを同時に底上げできる。チェストボイスの安定から始めるのが近道。'},
  {f0:[272,330],arch:'メゾソプラノ型',gender:'f',desc:'クリアさと明るさを持ちながら深みもある声域。透明感と表現力が共存し、歌声では豊かな感情表現が可能。',tip:'<strong>腹式呼吸の支え強化</strong>と、チェストからヘッドへの<strong>なめらかなミックスボイス</strong>を磨くと表現幅が大きく広がる。'},
  {f0:[330,800],arch:'ソプラノ / ハイトーン型',gender:'f',desc:'明るく透き通る高音域。若々しい印象と抜けの良さが特徴で、感情表現の振れ幅が大きい。歌声では特に輝く音域。',tip:'高音域の<strong>腹式呼吸の支え</strong>が最重要。喉に頼らない発声を習得すると高音でも疲れにくくなる。'},
];
function getProfile(m){
  if(!m||!m.medPitch)return null;
  const f0=m.medPitch;
  for(const p of PROFILES)if(f0>=p.f0[0]&&f0<p.f0[1])return p;
  return PROFILES[PROFILES.length-1];
}

// ══════════════════════════════════════════════
//  VOICE DATABASE — 285 voices
//  [name, role, g(m/f), genre(va/actor/singer/narrator), note, f0lo, f0hi, warm(0-2), bright(0-2)]
//  f0lo/hi = 話し声の典型的周波数レンジ (Hz)
//  warm: 0=ダーク/低域少, 1=バランス, 2=温かみ強い
//  bright: 0=暗め, 1=バランス, 2=明るく抜ける
// ══════════════════════════════════════════════
const DB=[
// ── 男性 バス (55-90Hz) ──
['大塚明夫','声優','m','va','深く落ち着いた低音の代名詞。洋画吹替・ゲームで絶大な支持',72,115,2,0],
['玄田哲章','声優','m','va','太く力強いバスボイス。切れ味ある重低音',78,118,1,1],
['田中正彦','声優','m','va','落ち着いた中厚な低音のベテラン声優',75,108,1,0],
['内田直哉','声優','m','va','温かみある重量感ある低音が特徴',80,112,2,0],
['藤真秀','声優','m','va','柔らかみある重低音でドラマ的キャラを多数担当',78,112,2,0],
['柴田秀勝','声優','m','va','重く威圧感ある低音で悪役を多く演じる',73,105,1,0],
['大川透','声優','m','va','響く重低音と存在感ある発声',76,112,1,1],
['麦人','声優','m','va','澄んだ重厚な低音で多くの名キャラを担当',78,115,1,0],
['阪脩','声優','m','va','温かみある深い低音の大ベテラン',73,108,2,0],
['James Earl Jones','俳優','m','actor','ダース・ベイダーの声で知られる重低音の象徴',74,112,2,0],
['仲代達矢','俳優','m','actor','深く重厚な低音が風格と迫力を生む名優',78,110,1,0],
['三船敏郎','俳優','m','actor','力強く鋭い低音で武士の凄みを体現',78,112,1,1],
['勝新太郎','俳優','m','actor','太く力強い低音の個性派名優',78,115,1,1],
['山崎努','俳優','m','actor','クリアで知性的な低音の名優',80,112,1,0],
['石原裕次郎','歌手・俳優','m','singer','深みと色気ある低バリトン系のスター',108,148,2,0],
['Barry White','歌手','m','singer','深い低音と甘い歌声でR&Bレジェンド',70,105,2,0],
['布施明','歌手','m','singer','豊かで温かい低音のバラード歌手',82,115,2,0],
['北島三郎','歌手','m','singer','力強く温かみある演歌の巨星',80,112,2,1],
['五木ひろし','歌手','m','singer','クリアで安定した演歌の重鎮',82,118,1,0],
['谷村新司','歌手','m','singer','澄んだ低バリトンのフォーク名匠',92,132,1,0],
['市村正親','俳優・歌手','m','singer','ミュージカル界で活躍する深いバス〜バリトン',80,120,2,1],
['小林清志','声優・ナレーター','m','narrator','温かみある低音で次元大介を長年担当',82,118,2,0],
['立木文彦','声優・ナレーター','m','narrator','重厚な温かみある低音でナレーションを多数担当',88,128,2,1],
// ── 男性 バス・バリトン (88-118Hz) ──
['安元洋貴','声優','m','va','深く温かい声で悪役からイケメンまで幅広く担当',90,132,2,1],
['中田譲治','声優','m','va','低く鋭い音色で謎めいたキャラ多数',88,128,1,1],
['鳥海浩輔','声優','m','va','渋みある低バリトン。落ち着いた大人の声',110,148,2,0],
['小山力也','声優','m','va','力強い低バリトン。マーベル系吹替を多く担当',108,148,1,1],
['宮本充','声優','m','va','落ち着いた深みある低バリトン',108,148,1,0],
['草尾毅','声優','m','va','落ち着きある低バリトン。多くのキャラを担当',112,150,1,0],
['矢沢永吉','歌手','m','singer','エッジ立つ骨太なロックバリトン',90,132,1,1],
['長渕剛','歌手','m','singer','硬質でアグレッシブな低バリトン',90,132,1,1],
['忌野清志郎','歌手','m','singer','ロックとソウルが融合した独特の低バリトン',95,138,1,2],
['美川憲一','歌手','m','singer','独特の存在感ある低バリトン',90,128,1,1],
['村下孝蔵','歌手','m','singer','温かみある落ち着いたバリトン系フォークシンガー',95,135,2,0],
['細川たかし','歌手','m','singer','力強い低バリトン系の演歌歌手',110,148,1,1],
['渡辺謙','俳優','m','actor','ハリある低音と国際的な存在感',88,128,1,1],
['西田敏行','俳優','m','actor','人情味ある温かい低音の名優',90,128,2,0],
['高橋克典','俳優','m','actor','落ち着いた温かみある低バリトン',90,130,2,0],
['仲村トオル','俳優','m','actor','温かみと渋さを持つ低バリトン',92,132,2,0],
['佐藤浩市','俳優','m','actor','硬質でエネルギーある低バリトン',92,132,1,1],
['内野聖陽','俳優','m','actor','力強く明快な低バリトン',115,155,1,1],
['古舘伊知郎','アナウンサー','m','narrator','エネルギッシュで迫力ある独特のバリトン',92,132,1,1],
['安住紳一郎','アナウンサー','m','narrator','張りのある低バリトンのNHKトップアナ',95,135,1,1],
['桐本琢也','ナレーター','m','narrator','力強い低バリトンでドキュメンタリーを多数担当',90,128,1,1],
// ── 男性 低バリトン (118-138Hz) ──
['森川智之','声優','m','va','温かみある中低音で長年トップに君臨',102,148,2,1],
['中村悠一','声優','m','va','落ち着きと温かさが共存する低バリトン',105,148,2,1],
['速水奨','声優','m','va','深くしっとりした温かみある声',100,142,2,0],
['小西克幸','声優','m','va','切れ味ある低バリトン',115,152,1,1],
['関智一','声優','m','va','明るさとエネルギーある低バリトン',115,158,1,2],
['保志総一朗','声優','m','va','クリアで爽やかさある低バリトン',122,162,1,2],
['置鮎龍太郎','声優','m','va','落ち着きある中バリトン',118,158,1,1],
['森久保祥太郎','声優','m','va','深みと渋さある低バリトン',112,152,1,1],
['三木眞一郎','声優','m','va','柔らかく温かいバリトン〜テノール境界',128,168,2,1],
['玉置浩二','歌手','m','singer','温かく深い低バリトン。日本最高峰のバラードシンガー',108,155,2,1],
['山下達郎','歌手','m','singer','温かみある低バリトンでスタジオ音楽の職人',112,158,2,1],
['さだまさし','歌手','m','singer','柔らかく温かいフォークバラードの低バリトン',115,158,2,0],
['尾崎豊','歌手','m','singer','熱量と存在感ある低バリトン。伝説的な若者の声',118,165,1,2],
['吉田拓郎','歌手','m','singer','骨太でエネルギッシュなロックフォーク',112,158,1,1],
['西城秀樹','歌手','m','singer','力強く情熱的な低バリトンのアイドル歌手',115,158,1,1],
['小椋佳','歌手','m','singer','穏やかで温かみある低バリトンのシンガーソングライター',110,155,2,0],
['布袋寅泰','歌手・ギタリスト','m','singer','独特の低めバリトンでロックを体現',118,158,1,1],
['浜田省吾','歌手','m','singer','力強い存在感あるバリトン〜テノール',118,168,1,1],
['吉川晃司','歌手・俳優','m','singer','力強いバリトン系のロックシンガー',118,162,1,1],
['甲斐よしひろ','歌手','m','singer','ロックとソウルを融合した個性的なバリトン',125,172,1,1],
['Frank Sinatra','歌手','m','singer','バリトンの甘みと安定感で世界を魅了したジャズレジェンド',122,162,2,1],
['Dean Martin','歌手','m','singer','温かく甘いバリトン系ジャズシンガー',120,158,2,1],
['Elvis Presley','歌手','m','singer','深みと色気あるバリトン、ロック&ロールの帝王',120,162,2,1],
['役所広司','俳優','m','actor','温かみと深みが共存する名優',108,148,2,1],
['堤真一','俳優','m','actor','落ち着きある温かい低バリトン',112,152,2,1],
['豊川悦司','俳優','m','actor','深みと色気ある温かい低バリトン',108,148,2,0],
['松田龍平','俳優','m','actor','個性的な低バリトンで強い存在感',112,152,1,1],
['夏八木勲','俳優','m','actor','重厚感と存在感ある低バリトンの名優',108,148,1,0],
['Morgan Freeman','俳優','m','actor','穏やかで包容力のある温かいバリトン。ナレーションの名手',105,145,2,0],
['羽鳥慎一','アナウンサー','m','narrator','力強く聴きやすい低バリトンアナウンサー',115,155,1,1],
// ── 男性 高バリトン (138-162Hz) ──
['津田健次郎','声優','m','va','低めの色気ある高バリトン。つーちゃんボイスとして人気',112,158,2,1],
['宮野真守','声優','m','va','温かみある高バリトン。アニメ界の二大巨頭のひとり',122,168,2,1],
['鈴村健一','声優','m','va','柔らかな温かみある高バリトン',118,158,2,1],
['鈴木達央','声優','m','va','エッジが立ちエネルギッシュな高バリトン',120,162,1,2],
['細谷佳正','声優','m','va','明るくシャープな高バリトン',125,165,1,2],
['杉田智和','声優','m','va','個性的でエネルギーある高バリトン',125,168,1,2],
['福山潤','声優','m','va','明るく高めの高バリトン〜テノール',132,178,1,2],
['浪川大輔','声優','m','va','温かみある高バリトン〜テノール境界',128,175,2,1],
['高橋広樹','声優','m','va','独特の音色ある高バリトン',125,165,1,1],
['堺雅人','俳優','m','actor','温かみと知性を持つ高バリトン',125,162,2,1],
['生田斗真','俳優','m','actor','柔らかく温かみある高バリトン',128,165,2,1],
['妻夫木聡','俳優','m','actor','親しみやすい温かい高バリトン',125,162,2,1],
['岡田准一','俳優','m','actor','エネルギーとハリのある高バリトン',128,165,1,2],
['山田孝之','俳優','m','actor','落ち着いた低めの高バリトン',125,158,1,0],
['大泉洋','俳優・タレント','m','actor','親しみやすいバリトン〜テノール境界',130,172,2,1],
['吉田鋼太郎','俳優','m','actor','力強い存在感ある高バリトン',120,158,1,1],
['福山雅治','歌手・俳優','m','singer','甘みある温かい高バリトン。J-Popバラードの顔',125,162,2,1],
['徳永英明','歌手','m','singer','柔らかく深みある高バリトンバラード',128,165,2,0],
['槇原敬之','歌手','m','singer','温かみと甘さのある高バリトンポップス',128,168,2,1],
['桑田佳祐','歌手','m','singer','エネルギーとソウルあふれる高バリトン〜テノール',122,175,1,2],
['奥田民生','歌手','m','singer','骨太でグルーヴィーな高バリトンロック',125,165,1,2],
['米津玄師','歌手','m','singer','独特の音色持つ現代のバリトン〜テノール',140,192,1,2],
['秦基博','歌手','m','singer','温かみある澄んだ高バリトン〜テノール',145,192,2,1],
['藤井風','歌手','m','singer','独特の音色と表現力を持つバリトン〜テノール',138,192,2,1],
['Tom Jones','歌手','m','singer','力強く情熱的なバリトン〜テノール',128,175,1,2],
['Ed Sheeran','歌手','m','singer','澄んだブリティッシュポップの高バリトン',128,168,1,1],
['成田紀寛','ナレーター','m','narrator','穏やかで温かい高バリトンのナレーター',128,165,2,1],
// ── 男性 テノール (162-200Hz) ──
['神谷浩史','声優','m','va','表現力豊かなテノール。温かい声の第一人者',150,198,1,1],
['梶裕貴','声優','m','va','明るくエネルギッシュなテノール',155,202,1,2],
['小野賢章','声優','m','va','明瞭で温かみあるテノール',155,200,1,1],
['石田彰','声優','m','va','澄んで知的なテノール。作品を超えた個性',150,195,0,1],
['緑川光','声優','m','va','クリアで印象的なテノール',155,200,0,1],
['花江夏樹','声優','m','va','明るく表現力豊かなテノール',155,205,1,2],
['松岡禎丞','声優','m','va','パワフルで張りのあるテノール',152,200,1,2],
['石川界人','声優','m','va','柔らかく温かみあるテノール',150,198,2,1],
['木村拓哉','俳優','m','actor','親しみある温かいテノール',155,198,1,1],
['小栗旬','俳優','m','actor','温かみと存在感あるテノール',155,200,1,1],
['吉沢亮','俳優','m','actor','清潔感ある温かいテノール',155,200,2,1],
['山崎賢人','俳優','m','actor','若々しく明るいテノール',158,202,1,2],
['三浦翔平','俳優','m','actor','明るく張りのあるテノール',158,202,1,2],
['岡田将生','俳優','m','actor','明るく爽やかなテノール',160,205,1,2],
['眞島秀和','俳優','m','actor','個性的なテノール〜ハイテノール域',158,208,1,1],
['平井堅','歌手','m','singer','深みと温かみのあるテノール。日本屈指のバラード歌手',150,200,2,1],
['久保田利伸','歌手','m','singer','ソウルフルで温かみあるテノール',155,205,2,1],
['CHAGE','歌手','m','singer','温かく豊かなテノール（CHAGE and ASKA）',155,198,2,1],
['稲葉浩志','歌手','m','singer','爆発的パワーと高音を持つテノール、B\'zのボーカル',155,215,1,2],
['井上陽水','歌手','m','singer','独特の個性ある哲学的なテノール',152,198,1,1],
['ゆず（北川悠仁）','歌手','m','singer','爽やかで透き通るテノール',162,215,1,2],
['ゆず（岩沢厚治）','歌手','m','singer','温かみある低めのテノール',158,205,2,1],
['back number（清水依与吏）','歌手','m','singer','柔らかく温かみあるテノール',155,205,2,1],
['スキマスイッチ（大橋卓弥）','歌手','m','singer','爽やかで表現力豊かなテノール',158,210,1,2],
['amazarashi（秋田ひろむ）','歌手','m','singer','独特の低いテノール〜バリトン境界',140,185,1,1],
['坂本九','歌手','m','singer','スキヤキで世界的に知られた明るいテノール',155,205,2,2],
['氷川きよし','歌手','m','singer','澄んで力強い演歌テノール',148,198,1,2],
// ── 男性 ハイテノール (195-245Hz) ──
['下野紘','声優','m','va','高く温かみある明るいテノール域、多くの主役を担当',188,238,1,2],
['入野自由','声優','m','va','温かみある高テノール',185,235,1,1],
['岡本信彦','声優','m','va','エネルギッシュで個性的なハイテノール',188,238,1,2],
['内山昂輝','声優','m','va','落ち着きある高テノール',182,230,1,1],
['村瀬歩','声優','m','va','明るく清潔感あるハイテノール',188,238,1,2],
['斉藤壮馬','声優','m','va','独特の音色持つハイテノール',185,235,1,1],
['ASKA','歌手','m','singer','圧倒的な声域幅と温かみある高テノール（CHAGE and ASKA）',178,248,2,2],
['稲葉浩志 (高域)','歌手','m','singer','ハイパワーな高テノール域まで届くB\'zのボーカル',195,250,1,2],
['King Gnu（井口理）','歌手','m','singer','超高音まで使いこなすハイテノール',188,272,1,2],
['甲斐よしひろ (高域)','歌手','m','singer','ロックに情熱を注ぐハイテノール域',185,242,1,1],
// ── 女性 コントラルト (162-238Hz) ──
['坂本真綾','声優・歌手','f','va','温かく豊かなコントラルト〜メゾの第一人者',175,248,2,1],
['大原さやか','声優','f','va','ナウシカの声で知られる温かみある落ち着いたコントラルト',170,232,2,0],
['島本須美','声優','f','va','穏やかで知的なコントラルト〜メゾ',172,232,1,0],
['日高のり子','声優','f','va','温かく親しみやすいコントラルト〜メゾ',175,245,2,1],
['岡本麻弥','声優','f','va','深みと落ち着きある独特のコントラルト',168,228,1,0],
['中原麻衣','声優','f','va','明るく爽やかなコントラルト〜メゾ境界',205,260,1,2],
['黒木瞳','女優','f','actor','温かく落ち着いたコントラルト系の声',172,230,2,0],
['松嶋菜々子','女優','f','actor','包容力あるコントラルト',175,232,2,0],
['常盤貴子','女優','f','actor','温かみあるコントラルト域',172,230,2,0],
['黒木華','女優','f','actor','独特の落ち着いた低め声域',168,228,1,0],
['天海祐希','女優','f','actor','豊かで堂々としたコントラルト〜メゾ。舞台・映像で映える',175,238,2,1],
['吉田羊','女優','f','actor','深みと大人の魅力のコントラルト〜メゾ',175,235,1,1],
['竹内まりや','歌手','f','singer','温かく包容力あるコントラルト系ポップス',175,240,2,0],
['荒井由実（松任谷由実）','歌手','f','singer','温かくレトロな魅力のコントラルト系',175,238,2,1],
['中島みゆき','歌手','f','singer','深く感情的なコントラルト〜メゾ。伝説的名曲多数',170,248,2,1],
['山口百恵','歌手','f','singer','クリアで凛としたコントラルト',175,235,1,0],
['高橋真梨子','歌手','f','singer','哀愁あるコントラルト〜メゾのベテランシンガー',178,245,2,1],
['坂本冬美','歌手','f','singer','張りある声の演歌コントラルト',175,240,1,1],
['由紀さおり','歌手','f','singer','清潔感あるコントラルト系のポップシンガー',178,242,1,0],
['石川さゆり','歌手','f','singer','深みと情感のある演歌コントラルト',172,235,2,1],
['都はるみ','歌手','f','singer','情感豊かな演歌コントラルト〜メゾ',225,278,2,1],
['あいみょん','歌手','f','singer','独特の温かみある低めメゾアルト〜コントラルト',175,242,2,1],
['有働由美子','アナウンサー','f','narrator','力強いコントラルト〜メゾ境界のベテランアナ',175,235,1,1],
['久保純子','アナウンサー','f','narrator','落ち着いたコントラルト〜メゾのプロアナ',172,232,1,0],
// ── 女性 メゾアルト (230-272Hz) ──
['林原めぐみ','声優','f','va','個性的な音色と温かみでトップを走るメゾの代名詞',228,275,2,1],
['沢城みゆき','声優','f','va','重厚さとクリアさを持ち合わせた表現力抜群',232,285,1,2],
['田中理恵','声優','f','va','深みと温かみある落ち着いたメゾ',235,278,2,1],
['川澄綾子','声優','f','va','落ち着きある温かいメゾアルト',238,285,2,0],
['皆川純子','声優','f','va','独特の甘みあるメゾアルト〜メゾソプラノ',235,295,2,1],
['深津絵里','女優','f','actor','明るく爽やかなメゾアルト',235,278,1,2],
['小池栄子','女優・タレント','f','actor','力強く個性的なメゾアルト',235,278,1,1],
['仲間由紀恵','女優','f','actor','明快で存在感あるメゾアルト',235,278,1,2],
['宇多田ヒカル','歌手','f','singer','温かく深みあるメゾアルト。J-Popの唯一無二',228,290,2,1],
['椎名林檎','歌手','f','singer','個性的でエッジある明るいメゾアルト',232,292,1,2],
['倖田來未 (低域)','歌手','f','singer','艶やかで明るいメゾアルト',232,278,1,2],
['大原櫻子 (低域)','歌手','f','singer','爽やかなメゾアルト',235,278,1,1],
['太田裕美','歌手','f','singer','柔らかく温かみあるメゾアルト〜メゾソプラノ',238,282,2,0],
['今井美樹','歌手','f','singer','落ち着きある温かいメゾアルト',238,288,2,0],
['中森明菜','歌手','f','singer','深みと個性ある独自スタイルのメゾアルト〜メゾソプラノ',235,295,2,1],
['杏里','歌手','f','singer','爽やかなメゾアルト〜メゾソプラノ',238,285,1,1],
['八代亜紀','歌手','f','singer','深みある演歌メゾアルト、雨の慕情で有名',228,278,2,1],
['久保田早紀','歌手','f','singer','個性的で澄んだメゾアルト（異邦人で有名）',235,285,1,0],
['南里侑香','アナウンサー','f','narrator','落ち着きある温かいメゾアルトのアナウンサー',238,278,2,1],
// ── 女性 メゾソプラノ (268-332Hz) ──
['水樹奈々','声優','f','va','力強く豊かなメゾソプラノ。アニソン界の女王',268,322,1,2],
['伊藤静','声優','f','va','温かみある中域のメゾソプラノ',265,318,2,1],
['早見沙織 (低域)','声優・歌手','f','va','澄んで整ったメゾソプラノ',265,320,0,1],
['佐倉綾音','声優','f','va','明るく爽やかなメゾソプラノ',265,318,1,2],
['茅野愛衣','声優','f','va','清潔感あるメゾソプラノ',265,312,1,1],
['白石涼子','声優','f','va','爽やかで明快なメゾソプラノ',272,335,1,2],
['名塚佳織','声優','f','va','柔らかで温かみあるメゾソプラノ',268,328,2,0],
['生天目仁美','声優','f','va','独特の個性ある高めのメゾソプラノ',278,348,1,2],
['遠藤綾','声優','f','va','クリアなメゾソプラノ',272,335,0,1],
['新垣結衣','女優','f','actor','温かく爽やかなメゾソプラノ',265,325,2,1],
['広瀬すず','女優','f','actor','明るく親しみやすいメゾソプラノ',265,320,1,2],
['石原さとみ','女優','f','actor','柔らかく温かいメゾソプラノ',265,320,2,1],
['長澤まさみ','女優','f','actor','力強く明るいメゾソプラノ',268,325,1,2],
['綾瀬はるか','女優','f','actor','爽やかで明快なメゾソプラノ',268,322,1,2],
['有村架純','女優','f','actor','柔らかく親しみやすいメゾソプラノ',265,320,2,1],
['上戸彩','女優','f','actor','明るいメゾソプラノ',268,322,1,2],
['絢香','歌手','f','singer','深みと温かみあるメゾソプラノソウル',268,328,2,1],
['大原櫻子','歌手','f','singer','温かく爽やかなメゾソプラノ',272,332,1,1],
['倖田來未','歌手','f','singer','艶やかで明るいメゾソプラノ',268,332,1,2],
['安室奈美恵','歌手','f','singer','シャープで明快なメゾソプラノ',268,330,1,2],
['加藤ミリヤ','歌手','f','singer','個性的で明るいメゾソプラノ',272,332,1,2],
['岡村孝子','歌手','f','singer','柔らかく澄んだメゾソプラノ',268,328,2,0],
['今井美樹 (高域)','歌手','f','singer','落ち着きある温かいメゾソプラノ',272,330,2,0],
['浜崎あゆみ','歌手','f','singer','エネルギッシュで存在感あるメゾソプラノ',268,330,1,2],
['岩崎宏美','歌手','f','singer','クリアで力強いメゾソプラノ〜ソプラノ境界',285,368,0,1],
['森口博子','歌手','f','singer','パワフルなメゾソプラノ〜ソプラノ境界',282,365,1,2],
// ── 女性 ソプラノ (310-430Hz) ──
['花澤香菜','声優','f','va','透き通る声でありながら独特の温かみを持つトップ声優',308,392,2,1],
['悠木碧','声優','f','va','個性的で多彩な表現を持つハイトーン',308,408,1,2],
['竹達彩奈','声優','f','va','明るく抜けるハイトーンボイス',308,395,1,2],
['三石琴乃','声優・ナレーター','f','narrator','温かく包容力あるソプラノ。セーラームーンの声',302,382,2,1],
['日笠陽子','声優','f','va','エネルギッシュで明るいソプラノ',308,395,1,2],
['小清水亜美','声優','f','va','温かみあるクリアなソプラノ',305,388,2,1],
['釘宮理恵','声優','f','va','ツンデレ声として有名な独特の個性的ソプラノ',308,398,1,2],
['能登麻美子','声優','f','va','柔らかく穏やかな中高ソプラノ',295,375,2,0],
['堀江由衣','声優','f','va','明るくキュートなソプラノ',312,400,1,2],
['早見沙織','声優・歌手','f','va','澄んで整った美しいソプラノ。歌手としても活躍',305,395,0,1],
['中村繪里子','声優','f','va','明るくエネルギッシュなソプラノ',312,402,1,2],
['喜多村英梨','声優','f','va','パワフルで印象的なソプラノ',288,375,1,2],
['加藤英美里','声優','f','va','明るくキュートなソプラノ',315,405,1,2],
['豊崎愛生','声優','f','va','高い透明感のあるソプラノ',308,398,0,1],
['内田真礼','声優・歌手','f','va','明るく個性あるメゾソプラノ〜ソプラノ',285,372,1,2],
['伊藤美来','声優・歌手','f','va','明るく通るソプラノ',308,402,1,2],
['堀北真希','女優','f','actor','清潔感ある温かいソプラノ',305,382,2,1],
['浜辺美波','女優','f','actor','澄んで明るいソプラノ',308,388,1,2],
['川口春奈','女優','f','actor','明るく存在感あるソプラノ',308,392,1,2],
['土屋太鳳','女優','f','actor','元気で明快なソプラノ',312,398,1,2],
['LiSA','歌手','f','singer','力強いハイトーンでアニメソングの女王',308,412,1,2],
['Aimer','歌手','f','singer','ハイトーンでありながら独特のハスキーな艶が共存',302,398,1,1],
['西野カナ','歌手','f','singer','共感しやすい明るいソプラノ',308,398,1,2],
['MISIA','歌手','f','singer','温かく力強い超高音域のR&Bソプラノ',302,425,2,2],
['Ado','歌手','f','singer','超高音まで使いこなす圧倒的な音域とパワー',295,458,1,2],
['夏川りみ','歌手','f','singer','温かく包容力あるソプラノ。涙そうそうで大ヒット',305,395,2,1],
['May J.','歌手','f','singer','温かみある豊かなソプラノ',305,398,2,1],
['平原綾香','歌手','f','singer','力強く豊かなソプラノ、クラシックとポップを融合',302,405,2,1],
['美空ひばり','歌手','f','singer','日本最高峰の歌手、圧倒的な表現力のソプラノ',298,395,2,2],
['松田聖子','歌手','f','singer','ポップで明るいソプラノ、80年代アイドルの女王',295,408,2,2],
['柴咲コウ','歌手・女優','f','singer','独特の音色を持つメゾソプラノ〜ソプラノ',295,385,1,2],
['鬼束ちひろ','歌手','f','singer','独特のダークなソプラノ、圧倒的な存在感',295,388,1,2],
['中島美嘉','歌手','f','singer','哀愁あるメゾアルト〜メゾソプラノ',238,295,1,1],
['岩崎良美','歌手','f','singer','明るいソプラノポップス',305,392,1,2],
['観月ありさ','歌手・女優','f','singer','明るく爽やかなソプラノ系',302,388,1,2],
['広瀬香美','歌手','f','singer','冬の歌で有名な明るいソプラノ',308,402,1,2],
['YOASOBI（ikura）','歌手','f','singer','独特の語りかけるようなメゾソプラノ〜ソプラノ',285,378,1,2],
['ヨルシカ（suisu）','歌手','f','singer','個性的で澄んだメゾソプラノ',280,368,0,1],
['寿美菜子','声優','f','va','明るく爽やかなメゾソプラノ〜ソプラノ',285,368,1,2],
['GReeeeN（ヒデ）','歌手','m','singer','透明感あるソフトテノール系',158,210,2,1],
['ゴスペラーズ（黒沢薫）','歌手','m','singer','パワフルなテノール系コーラスリード',152,205,1,2],
];

// ══════════════════════════════════════════════
//  VOICE MATCHING ENGINE
// ══════════════════════════════════════════════
function findMatches(metrics, userProfile){
  const f0=metrics.medPitch;
  if(!f0) return null;
  const lo=metrics.minPitch||(f0*0.87);
  const hi=metrics.maxPitch||(f0*1.13);
  const userSpan=Math.max(hi-lo,10);
  const w=metrics.warmth>0.26?2:metrics.warmth>0.17?1:0;
  const b=(metrics.brightness>0.065||metrics.centroid>1850)?2:metrics.brightness>0.04?1:0;

  const scored=DB.map(([n,r,g,genre,note,f0lo,f0hi,warm,bright])=>{
    // Range overlap score (main signal)
    const overlap=Math.min(hi,f0hi)-Math.max(lo,f0lo);
    const voiceSpan=f0hi-f0lo;
    let score=0;
    if(overlap>0){
      score+=Math.round((overlap/Math.max(userSpan,voiceSpan,10))*52);
    } else {
      const gap=Math.min(Math.abs(lo-f0hi),Math.abs(hi-f0lo));
      score+=Math.max(0,32-Math.round(gap/1.8));
    }
    // Median F0 proximity to voice center
    const vc=(f0lo+f0hi)/2;
    score+=Math.max(0,22-Math.round(Math.abs(f0-vc)/2.5));
    // Timbre match
    if(warm===w)score+=14;else if(Math.abs(warm-w)===1)score+=7;
    if(bright===b)score+=10;else if(Math.abs(bright-b)===1)score+=5;
    return{n,r,g,genre,note,score};
  });

  const sel=(userProfile.refType||[]);
  const genres=sel.length>0?sel:['va','singer','actor'];
  const glabel={va:'声優',actor:'俳優・タレント',singer:'歌手・アーティスト',narrator:'アナウンサー・ナレーター'};
  const isMixed=f0>=200&&f0<235;
  const result={isMixed,total:DB.length};
  for(const genre of genres){
    const pool=scored.filter(v=>v.genre===genre).sort((a,b)=>b.score-a.score);
    result[genre]={label:glabel[genre],voices:pool.slice(0,5)};
  }
  return result;
}

// ══════════════════════════════════════════════
//  SCORING
// ══════════════════════════════════════════════
function scorePeak(v,lo,hi,absLo,absHi){
  if(v>=lo&&v<=hi)return 100;if(v<absLo||v>absHi)return 10;
  return v<lo?10+((v-absLo)/(lo-absLo))*90:10+((absHi-v)/(absHi-hi))*90;
}
function computeScores(m){
  if(!m||!m.medPitch)return{male:0,female:0};
  const{medPitch:f0,stability,centroid,warmth,hnr}=m;
  const mp=scorePeak(f0,95,158,62,220),mw=Math.min(100,warmth*380),ms=stability*100,mh=hnr,mc=Math.max(10,Math.min(100,110-(centroid-500)/22));
  const male=Math.round(mp*.28+mw*.25+ms*.22+mh*.17+mc*.08);
  const fp=scorePeak(f0,168,270,110,400),fh=hnr,fs=stability*100,fc=scorePeak(centroid,1200,2600,700,3800);
  const fw=warmth>0.12&&warmth<0.38?(1-Math.abs(warmth-0.24)/0.24)*100:Math.max(10,40-Math.abs(warmth-0.24)*150);
  const female=Math.round(fp*.28+fh*.25+fs*.20+fc*.15+fw*.12);
  return{male:Math.max(12,Math.min(97,male)),female:Math.max(12,Math.min(97,female))};
}
function voiceRange(f0){
  if(!f0)return'計測不可';
  if(f0<88)return'バス';if(f0<118)return'バス・バリトン';if(f0<138)return'低バリトン';
  if(f0<162)return'高バリトン';if(f0<200)return'テノール';if(f0<235)return'ハイテノール / コントラルト';
  if(f0<272)return'メゾアルト';if(f0<330)return'メゾソプラノ';return'ソプラノ';
}
function stars(n){const s=Math.round(Math.max(1,Math.min(5,n/20)));return'★'.repeat(s)+'☆'.repeat(5-s)}

// ══════════════════════════════════════════════
//  CONTENT GENERATION
// ══════════════════════════════════════════════
function genExplain(m,sc,vp,st){
  if(!m||!m.medPitch)return'声が検出できませんでした。';
  const f0=Math.round(m.medPitch),stabP=Math.round(m.stability*100),hnrP=Math.round(m.hnr);
  const mFocus=sc.male>=sc.female;
  let t=`基本周波数 <strong>${f0} Hz</strong>（${voiceRange(m.medPitch)}）、音色タイプ「<strong>${subTypeLabel(st).split('—')[0].trim()}</strong>」で分析しました。`;
  if(mFocus){t+=`男性基準のバリトン域（95〜158Hz）と比較すると、`;if(f0>=95&&f0<=158)t+=`この域に該当しておりスコアを大きく引き上げています。`;else if(f0<95)t+=`低音側に位置する個性的な重低音タイプです。`;else t+=`やや高め寄りで、重厚感より明瞭さが際立つ声質です。`;}
  else{t+=`女性基準のメゾ〜ソプラノ域（168〜270Hz）と比較すると、`;if(f0>=168&&f0<=270)t+=`この域に概ね合致しておりスコアを支えています。`;else if(f0<168)t+=`落ち着いた低めの声域で、深みのある大人の声質です。`;else t+=`明るい高音域で、透明感と若々しさが際立ちます。`;}
  t+=` ピッチ安定性 <strong>${stabP}%</strong>（${stabP>=70?'良好':'改善余地あり'}）、調波雑音比 <strong>${hnrP}/100</strong>。`;
  if(vp&&vp.gender==='mf')t+=` この声域は<strong>男女どちらにも現れる</strong>特徴的な帯域です。`;
  return t;
}
function genStrengths(m,sc){
  const out=[];
  if(m.stability>0.70)out.push({t:'sage',title:'ピッチの安定感',body:'音程のブレが少なく聴き手に安心感を与えます。プロのアナウンサーが重視する資質で「聴きやすい」という印象に直結します。'});
  if(m.warmth>0.22)out.push({t:'gold',title:'低域の豊かさ・温かみ',body:'声に低域成分が豊富で「温かみのある声」として評価されやすい特性です。日本語の音声文化では特に高く評価されます。'});
  if(m.hnr>62)out.push({t:'gold',title:'透明感のある倍音構造',body:'声帯が整った振動をしており、倍音が豊かで雑音が少ない澄んだ声です。録音映えしやすく、マイクを通すと際立ちます。'});
  if(m.medPitch<138)out.push({t:'sage',title:'説得力のある低音域',body:'低い声は聴き手の信頼感・安心感に直結します。「低い声の人はリーダーシップがある」と評価されやすいことが研究で示されています。'});
  if(m.pitchRange>80)out.push({t:'sage',title:'表現力のある声域幅',body:'話すときのピッチレンジが広く、抑揚をつけた表現が得意です。感情や強調の伝わり方が豊かで聴き手を引き込む力があります。'});
  if(m.brightness>0.07)out.push({t:'gold',title:'輝きのある高域成分',body:'声に高域の明るい成分が豊富で「通る声」「印象に残る声」として機能します。遠くまで聴こえやすく、講演での存在感に貢献します。'});
  if(out.length===0)out.push({t:'gold',title:'個性的な音色',body:'唯一無二の声質は磨き方次第で大きな武器になります。'});
  return out;
}
function genImprove(m,sc,up){
  const out=[];
  const purps=up.purposes||[],concerns=up.concerns||[],aspire=up.aspire;
  const singSel=purps.includes('sing')||(up.context||[]).includes('karaoke');
  if(m.stability<0.65)out.push('<strong>腹式呼吸の安定化：</strong>ピッチのブレを減らすには腹式呼吸が基本。毎日5分の「ロングトーン練習」が有効。');
  if(m.hnr<55)out.push('<strong>声帯のウォームアップ：</strong>発声前のリップロールやハミング練習で声帯をリラックスさせると声の澄み具合が改善します。十分な水分補給も効果的。');
  if(concerns.includes('weak')||m.brightness<0.04)out.push('<strong>共鳴腔の活用：</strong>「ん〜」と鼻に響かせるハミングから始め徐々に母音に繋げる練習が有効。声量より共鳴で声は「通る」ようになります。');
  if(aspire==='deeper'&&m.medPitch>160)out.push('<strong>低音側への発声拡張：</strong>自然な声域より1〜2音低めを意識して話す練習で印象が変わります。無理に低くすると喉を傷めるため慎重に。');
  if(singSel)out.push('<strong>歌のための発声強化：</strong>①腹式呼吸の支え　②ミックスボイスの習得　③フレーズごとのブレス配分、この3点が核心です。毎日15分の発声練習で数ヶ月で変化が出ます。');
  if(m.pitchRange<40&&purps.includes('speak'))out.push('<strong>抑揚のある話し方：</strong>重要な言葉の前に「間」を置き、少し高め/低めで強調するだけで印象が大きく変わります。');
  if(out.length===0)out.push('<strong>現状の磨き上げ：</strong>基本的な音響特性は良好です。声の録音を聴き返す習慣が最も効率的な上達法です。');
  return out;
}

function genderTag(g){
  if(g==='m')return'<span class="vp-gender-tag m">男性</span>';
  if(g==='f')return'<span class="vp-gender-tag f">女性</span>';
  return'';
}

function renderRefBox(matchResult,vp,up){
  if(!matchResult)return'';
  const sel=(up.refType||[]);
  const genres=sel.length>0?sel:['va','singer','actor'];
  const isMixed=matchResult.isMixed;
  const total=matchResult.total;

  let html=`<div class="vp-card"><div class="vp-top">`;
  html+=`<div class="vp-arch">${vp?vp.arch:'声域タイプ'}`;
  if(isMixed)html+=`<span class="vp-gender-tag mf" style="margin-left:10px">男女共通帯域</span>`;
  html+=`</div>`;
  html+=`<div style="font-family:var(--mono);font-size:9px;color:var(--gold);letter-spacing:2px;margin-bottom:5px">`;
  html+=`データベース ${total}名から音域・音色でマッチング</div>`;
  if(vp)html+=`<div class="vp-desc">${vp.desc}</div>`;
  html+=`</div>`;

  for(const genre of genres){
    const sect=matchResult[genre];
    if(!sect||!sect.voices.length)continue;
    html+=`<div class="vp-genre-head">${sect.label}</div><div class="vp-examples">`;
    for(const v of sect.voices){
      html+=`<div class="vp-ex"><div class="vp-nw"><div class="vp-name">${v.n}${isMixed?genderTag(v.g):''}</div><div class="vp-role">${v.r}</div></div><div class="vp-note">${v.note}</div></div>`;
    }
    html+=`</div>`;
  }
  if(vp)html+=`<div class="vp-tip">▸ <strong>次のステップ：</strong>${vp.tip}</div>`;
  html+=`</div>`;
  return html;
}

// ══════════════════════════════════════════════
//  QUIZ
// ══════════════════════════════════════════════
const userProfile={gender:null,age:null,purposes:[],concerns:[],refType:[],context:[],aspire:null};
const answers={};
function initQuiz(){
  document.querySelectorAll('.opts').forEach(grp=>{
    const mode=grp.dataset.mode,q=grp.dataset.q;
    grp.querySelectorAll('.opt').forEach(opt=>{
      opt.addEventListener('click',()=>{
        const v=opt.dataset.v;
        if(mode==='single'){grp.querySelectorAll('.opt').forEach(o=>o.classList.remove('sel'));opt.classList.add('sel');answers[q]=v;}
        else{opt.classList.toggle('sel');answers[q]=Array.from(grp.querySelectorAll('.opt.sel')).map(o=>o.dataset.v);}
        document.getElementById('quiz-bar').style.width=(Object.keys(answers).length/7*100)+'%';
      });
    });
  });
}
function applyAnswers(){
  userProfile.gender=answers.gender||null;userProfile.age=answers.age||null;
  userProfile.purposes=answers.purpose||[];userProfile.concerns=answers.concern||[];
  userProfile.refType=Array.isArray(answers.refType)?answers.refType:(answers.refType?[answers.refType]:[]);
  userProfile.context=answers.context||[];userProfile.aspire=answers.aspire||null;
}

// ══════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════
const analyzer=new VoiceAnalyzer();
const MAX_SEC=30;
let timerInt=null,secs=0,rafId=null,metrics=null;
function show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}
// canvas は描画開始時に遅延初期化（モジュールスコープでのDOM取得クラッシュを防ぐ）
let canvas=null,wCtx=null;
function initCanvas(){
  if(canvas)return true;
  canvas=document.getElementById('wave-canvas');
  if(!canvas)return false;
  wCtx=canvas.getContext('2d');
  return!!wCtx;
}
function drawWave(){
  if(!initCanvas())return;
  const W=canvas.clientWidth||300,H=canvas.clientHeight||96;
  if(canvas.width!==W)canvas.width=W;if(canvas.height!==H)canvas.height=H;
  wCtx.clearRect(0,0,W,H);wCtx.fillStyle='#2e2820';wCtx.fillRect(0,0,W,H);
  wCtx.strokeStyle='rgba(201,168,112,0.1)';wCtx.lineWidth=1;wCtx.beginPath();wCtx.moveTo(0,H/2);wCtx.lineTo(W,H/2);wCtx.stroke();
  const data=analyzer.timeDomain();
  if(data){wCtx.strokeStyle='#c9a870';wCtx.lineWidth=1.5;wCtx.beginPath();const step=W/data.length;for(let i=0;i<data.length;i++){const x=i*step,y=(0.5+data[i]*0.44)*H;i===0?wCtx.moveTo(x,y):wCtx.lineTo(x,y);}wCtx.stroke();}
  rafId=requestAnimationFrame(drawWave);
}
function startTimer(){
  secs=0;timerInt=setInterval(()=>{
    secs++;const mn=Math.floor(secs/60),sc=secs%60;
    document.getElementById('timer').textContent=`${mn}:${sc.toString().padStart(2,'0')}`;
    document.getElementById('progress-fill').style.width=Math.min(100,(secs/MAX_SEC)*100)+'%';
    if(secs>=MAX_SEC)doStop();
  },1000);
}
async function startRec(){
  try{await analyzer.start();}catch(e){const msg=e.message==='microphone_denied'?'マイクへのアクセスが拒否されました。\n\niPhoneの場合:\n設定アプリ → Safari → マイク → 許可\n\nまたはブラウザのURLバー左のアイコンからマイクを許可してください。':'マイクの起動に失敗しました: '+e.message;alert(msg);return;}
  document.getElementById('rec-dot').classList.add('on');document.getElementById('wave-status').textContent='REC';
  document.getElementById('btn-rec').disabled=true;document.getElementById('btn-submit').disabled=false;document.getElementById('btn-cancel').disabled=false;
  document.getElementById('rec-tip').textContent='読み終わったら「SUBMIT」を押してください。最大30秒で自動停止します。';
  startTimer();drawWave();
}
let _stopping=false;
function doStop(){
  if(_stopping)return; _stopping=true;
  clearInterval(timerInt);cancelAnimationFrame(rafId);metrics=analyzer.stop();
  document.getElementById('rec-dot').classList.remove('on');
  document.getElementById('btn-submit').disabled=true;
  document.getElementById('btn-cancel').disabled=true;
  show('s-scan');setTimeout(renderResults,2200);
}
function doCancel(){
  clearInterval(timerInt);cancelAnimationFrame(rafId);
  analyzer.stop(); // closes AudioContext (Fix D)
  resetRecUI();    // resets _stopping flag (Fix E)
  document.getElementById('rec-tip').textContent='REC START を押して録音を開始してください';
}
function resetRecUI(){
  _stopping=false; // Fix E: allow doStop to run again on next session
  document.getElementById('timer').textContent='0:00';document.getElementById('progress-fill').style.width='0%';
  document.getElementById('btn-rec').disabled=false;document.getElementById('btn-submit').disabled=true;
  document.getElementById('btn-cancel').disabled=true;document.getElementById('rec-dot').classList.remove('on');
  document.getElementById('wave-status').textContent='STANDBY';
}
function renderResults(){
  show('s-result');
  const err=document.getElementById('err-box');err.style.display='none';
  if(!metrics||!metrics.medPitch||metrics.n<3){
    err.style.display='block';err.textContent='声が十分に検出できませんでした。静かな環境でマイクに近づき、もう少し大きな声でお試しください。';
    ['str-list','imp-list','ref-box'].forEach(id=>document.getElementById(id).innerHTML='');return;
  }
  const sc=computeScores(metrics),vp=getProfile(metrics),st=getSubType(metrics),f0=metrics.medPitch;
  function hz2pct(hz){return Math.max(2,Math.min(97,((hz-60)/(420-60))*100));}
  setTimeout(()=>{
    document.getElementById('score-m').textContent=sc.male;document.getElementById('score-f').textContent=sc.female;
    document.getElementById('bar-m').style.width=sc.male+'%';document.getElementById('bar-f').style.width=sc.female+'%';
  },150);
  // 3-marker pitch ruler
  setTimeout(()=>{
    const minP=metrics.minPitch||f0,avgP=f0,maxP=metrics.maxPitch||f0;
    const minPct=hz2pct(minP),avgPct=hz2pct(avgP),maxPct=hz2pct(maxP);
    document.getElementById('mark-min').style.left=minPct+'%';
    document.getElementById('mark-avg').style.left=avgPct+'%';
    document.getElementById('mark-max').style.left=maxPct+'%';
    const rangePad=1;
    document.getElementById('ruler-range').style.left=Math.max(0,minPct-rangePad)+'%';
    document.getElementById('ruler-range').style.width=Math.max(0,maxPct-minPct+rangePad*2)+'%';
    document.getElementById('ml-min').style.left=minPct+'%';
    document.getElementById('ml-min').innerHTML=Math.round(minP)+'Hz<br><span style="font-size:8px;opacity:.8">最低</span>';
    document.getElementById('ml-avg').style.left=avgPct+'%';
    document.getElementById('ml-avg').innerHTML=Math.round(avgP)+'Hz<br><span style="font-size:8px;opacity:.8">平均</span>';
    document.getElementById('ml-max').style.left=maxPct+'%';
    document.getElementById('ml-max').innerHTML=Math.round(maxP)+'Hz<br><span style="font-size:8px;opacity:.8">最高</span>';
  },350);
  document.getElementById('explain-box').innerHTML=genExplain(metrics,sc,vp,st);
  document.getElementById('str-list').innerHTML=genStrengths(metrics,sc).map(s=>`<div class="str-item"><div class="str-title ${s.t}">◆ ${s.title}</div><div class="str-body">${s.body}</div></div>`).join('');
  document.getElementById('imp-list').innerHTML=genImprove(metrics,sc,userProfile).map(t=>`<div class="imp-item">${t}</div>`).join('');
  document.getElementById('ref-box').innerHTML=renderRefBox(findMatches(metrics,userProfile),vp,userProfile);
  document.getElementById('m-f0').textContent=`${Math.round(f0)} Hz`;
  document.getElementById('m-range').textContent=voiceRange(f0);
  document.getElementById('m-sub').textContent=subTypeLabel(st);
  const stabP=Math.round(metrics.stability*100);document.getElementById('m-stab').textContent=stars(stabP);setTimeout(()=>document.getElementById('bar-stab').style.width=stabP+'%',200);
  const hnrP=Math.round(metrics.hnr);document.getElementById('m-hnr').textContent=stars(hnrP);setTimeout(()=>document.getElementById('bar-hnr').style.width=hnrP+'%',200);
  const warmP=Math.round(Math.min(100,metrics.warmth*350));document.getElementById('m-warm').textContent=stars(warmP);setTimeout(()=>document.getElementById('bar-warm').style.width=warmP+'%',200);
  document.getElementById('m-cent').textContent=`${Math.round(metrics.centroid)} Hz`;
  document.getElementById('m-n').textContent=`${metrics.n} フレーム`;
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('btn-start').addEventListener('click',()=>show('s-quiz'));
  document.getElementById('btn-to-record').addEventListener('click',()=>{applyAnswers();show('s-record');});
  document.getElementById('btn-skip-quiz').addEventListener('click',()=>show('s-record'));
  document.getElementById('btn-rec').addEventListener('click',startRec);
  document.getElementById('btn-submit').addEventListener('click',doStop);
  document.getElementById('btn-cancel').addEventListener('click',doCancel);
  document.getElementById('btn-retry').addEventListener('click',()=>{resetRecUI();show('s-record');});
  document.getElementById('btn-requiz').addEventListener('click',()=>{resetRecUI();show('s-quiz');});
  initQuiz();
});
