import type { WorldMap, WorldEntity, WorldSave, Point, Rect } from './types';
import { sourceGrassAreas } from './encounters';

/** Original shared UE world coordinates. Sequence, gates and Chinese dialogue are Web adaptations. */
export const WORLD_ORIGIN:[number,number,number]=[129792,-224,-512];
const point=(x:number,y:number):Point=>({x:(x-WORLD_ORIGIN[0])/100,z:-(y-WORLD_ORIGIN[1])/100});
const area=(x:number,y:number,w:number,d:number):Rect=>({...point(x,y),w:w/100,d:d/100});
const nativeSource=(name:string)=>`/Game/MAPS/MAP_Overworld · ${name}；位置来自原组件，交互与中文对白为 Web 适配`;
const adaptedSource='Web 六区域探索路线：出口、解锁条件与补给用途为适配，不代表已执行原作完整蓝图。';
const at=(id:string,name:string,kind:WorldEntity['kind'],xy:[number,number],rest:Partial<WorldEntity>={}):WorldEntity=>({id,name,kind,...point(...xy),...rest});
const portal=(id:string,name:string,xy:[number,number],target:string,destination:[number,number],requires?:string):WorldEntity=>at(id,name,'portal',xy,{target,targetSpawn:point(...destination),requires,source:adaptedSource});
const sourceNote='原 Gamma Demo 106 关卡几何、对象位置、精灵与材质。此处的六区域顺序、中文对白、补给、出口与落点、任务条件为实时模式 Web 适配；出口和落点选在原地形可站立区域。五个道路/森林区域的遭遇范围来自原 GrassTile 位置，海滩营地外步行遭遇、草格包络、频率和物种为 Web 适配。使用原地形与已识别 WALL 树碰撞；原碰撞配置与脚本控制的 BlockingVolume 尚未复现，泛用 BlockingVolume 默认不启用。原作完整蓝图、过场与剧情时序尚未完整执行。';
function makeMap(id:string,name:string,subtitle:string,theme:WorldMap['theme'],sceneId:string,min:number[],max:number[],spawn:[number,number],entities:WorldEntity[],wild:number[],camp?:[number,number]):WorldMap {
  const bounds=area((min[0]+max[0])/2,(min[1]+max[1])/2,max[0]-min[0],max[1]-min[1]);
  const grass=sourceGrassAreas(sceneId);
  return{id,name,subtitle,theme,sourceMap:`/Game/MAPS/DemoIsland/${sceneId}`,sourceNote,bounds,spawn:point(...spawn),camp:camp?point(...camp):undefined,walkable:[bounds],blockers:[],terrain:[],props:[],entities,grass,wild,native:{sceneId,origin:WORLD_ORIGIN,ueBounds:{min,max},includeOverworld:true}};
}

// Main controller and persistence intentionally consume an ordered array.
export const WORLD_MAPS:WorldMap[]=[
  makeMap('beach','海岛海滩','DEMO ISLAND / BEACH','beach','MAP_DemoIsland_Beach',
    [129535.99946872558,-2529.010253906252,-893.6390991210938],[135680.00012909633,1984.0523505417582,.3316432237625122],
    [129792,-224],[
      at('captain-wake','皮特船长','npc',[129664,-160],{actor:'captain-pete',facing:'right',rewardFlag:'partner-ready',source:nativeSource('PaperFlipbookActor_14 / BP_CaptainPeteWakeUp'),dialogue:['你醒了。风暴把船带到了这片海岸，好在你的伙伴一直守在旁边。','沿海岸往东走，坡道上方有营地。先补充体力，再去东面的道路看看。','营地外的海岸和道路上的草丛都有野生精灵。和伙伴一起行走就可能遇到它们，遭遇后可以实时下达战术。']}),
      at('beach-note','营地里的便笺','pickup',[134985.300474012,-1120.877180913],{rewardFlag:'field-notes',source:nativeSource('BP_BirchNote_C_1'),dialogue:['你收好了营地留下的便笺与补给。获得伤药 ×1。','便笺提示：沿东面的道路继续探索；回来时，营地可以再次恢复伙伴。']}),
      at('beach-camp','海岸营地','heal',[134912,-1024],{source:'/Game/MAPS/DemoIsland/MAP_DemoIsland_Beach · 原帐篷西侧道路上的恢复点；位置与恢复功能为 Web 适配。',dialogue:['营火和帐篷挡住了海风。可以在这里休息，为伙伴恢复 HP 与所有招式的 PP。']}),
      at('larry-coast','Larry','npc',[134784.000014,-1056],{actor:'magma-larry',facing:'down',source:nativeSource('BP_Larry_Act1_StarterSpawn_C_0'),dialogue:['你也在寻找离开海岛的路？东面的道路还通着。','如果遇到训练家，先确认伙伴的 HP 和 PP。每次交锋之后，消耗都会保留下来。']}),
      portal('beach-east','海岛道路 101',[135488,0],'route101',[135872,0],'partner-ready'),
    ],[54,116],[134912,-1024]),
  makeMap('route101','海岛道路 101','DEMO ISLAND / ROUTE 101','meadow','MAP_DemoIsland_R101',
    [135679.9999616,-3200.000079872,-.0009175692684948444],[142336.0000384,3200,30.290084838867188],
    [135872,0],[
      portal('r101-west','海岛海滩',[135936,-192],'beach',[135360,0]),
      at('r101-guard','道路上的熔岩队员','trainer',[137408,160],{actor:'magma-grunt',speciesId:37,rewardFlag:'route101-clear',source:nativeSource('PaperFlipbookActor_15 / BP_MagmaGrunt'),dialogue:['要继续往东走，先让我看看你和伙伴的配合。','这次交锋可以随时下达战术与招式指令。准备好了再开始。']}),
      at('r101-field-cache','道路补给','pickup',[140352,1952],{source:'Web 补给点，设置于原发电机守卫附近的道路。',dialogue:['在道路旁找到一份补给。获得伤药 ×1。']}),
      at('r101-rest','路边休息点','heal',[140352,2144],{source:nativeSource('PaperFlipbookActor_55 / BP_MagmaGrunt_GeneratorGuard；此处恢复功能为 Web 适配'),dialogue:['在路边整理背包，让伙伴歇一会儿。恢复后再穿过前面的草地。']}),
      portal('r101-east','海岛道路 102',[142080,0],'route102',[142592,0],'route101-clear'),
    ],[25,37,54],[140352,2144]),
  makeMap('route102','海岛道路 102','DEMO ISLAND / ROUTE 102','meadow','MAP_DemoIsland_R102',
    [142335.9999404184,-3504.7997520348417,-394.6079406738281],[146943.998101275,3199.999886848,30.42563247680664],
    [142592,0],[
      portal('r102-west','海岛道路 101',[142656,-192],'route101',[141888,0]),
      at('r102-guard','低地的熔岩队员','trainer',[143488,-608],{actor:'magma-grunt',speciesId:111,rewardFlag:'route102-clear',source:nativeSource('PaperFlipbookActor_40 / BP_MagmaGrunt'),dialogue:['前方的道路会转向北面。先在这里分个高下吧。','观察距离与招式冷却，找到伙伴最合适的进攻时机。']}),
      at('r102-rest','低地休息点','heal',[143680,2144],{source:nativeSource('BP_Mori_C_1；恢复功能与标识为 Web 适配'),dialogue:['道路在这里变窄了。先恢复体力，再沿北面的标记继续前行。']}),
      portal('r102-north','海岛道路 103',[144640,2624],'route103',[144640,3264],'route102-clear'),
    ],[111,54,37],[143680,2144]),
  makeMap('route103','海岛道路 103','DEMO ISLAND / ROUTE 103','forest','MAP_DemoIsland_R103',
    [142335.998079131,2687.9996206913984,-381.64141845703125],[146943.99815285899,8831.998943565524,127.99853515625],
    [144640,3264],[
      portal('r103-south','海岛道路 102',[144640,3392],'route102',[144640,2496]),
      at('r103-guard','林间的熔岩队员','trainer',[145088,4320],{actor:'magma-grunt',speciesId:112,rewardFlag:'route103-clear',source:nativeSource('PaperFlipbookActor_44 / BP_MagmaGrunt'),dialogue:['这一段路通向灰烬森林。想过去的话，就先和我的伙伴较量一下。']}),
      at('rich-boy','富家少年','npc',[145248.173,7648.371],{actor:'rich-boy',facing:'left',source:'/Game/MAPS/MAP_Overworld · BP_RichBoy_C_5。原位置 UE [146080,7648] 位于不连通地块；Web 适配将互动与角色移到最近经连续行走验证的路边 UE [145248.173,7648.371]，对白为 Web 适配。',dialogue:['前面的景色和海岸很不一样。灰烬森林之后，还有一片蓝色的林地。','如果你的伙伴已经疲惫，先沿原路返回休息点。通向来路的出口一直开放。']}),
      at('r103-rest','林间休息点','heal',[144576,7712],{source:nativeSource('PaperFlipbookActor_59；此处恢复功能为 Web 适配'),dialogue:['你和伙伴在林间稍作休息。灰烬森林的入口就在北面。']}),
      portal('r103-north','灰烬森林',[144640,8512],'ashen',[144704,9600],'route103-clear'),
    ],[37,111,112],[144576,7712]),
  makeMap('ashen','灰烬森林','DEMO ISLAND / ASHEN FOREST','ash','MAP_AshenForest',
    [139679.99892936205,9083.363089762017,-231.51959228515625],[146975.9993237254,17919.994073169022,278.56182861328125],
    [144704,9600],[
      portal('ashen-south','海岛道路 103',[144640,9792],'route103',[144640,8256]),
      at('ashen-guard','发电机守卫','trainer',[144256,11168],{actor:'magma-grunt',speciesId:25,rewardFlag:'ashen-clear',source:nativeSource('PaperFlipbookActor_25 / BP_MagmaGrunt_GeneratorGuard'),dialogue:['你已经走到森林深处了。让我看看，你能不能应付这里的交锋。','准备好伙伴的招式与补给，再来挑战。']}),
      at('ashen-camp','灰烬森林营地','heal',[143360,13280],{source:nativeSource('BP_Demo_Shop_C_0；原商店位置，恢复功能为 Web 适配'),dialogue:['你在森林营地停下脚步。伙伴的 HP 与 PP 都会恢复，之后也可以从菜单返回这里。']}),
      at('yior','Yior','npc',[140800,15520],{actor:'yior',facing:'right',source:nativeSource('PaperFlipbookActor_0 / BP_YiorAshenForest'),dialogue:['森林北面的标记通向另一片林地。那里能看到蓝色的树冠和盛开的花。','这段路很长。出发前到营地休息，再检查一下补给。']}),
      at('larry-forest','Larry','npc',[141376.000014332,15584],{actor:'magma-larry',facing:'left',source:nativeSource('BP_Larry_Act2_C_1'),dialogue:['你从海岸一直走到了这里。带着伙伴继续往北吧。']}),
      at('sherry-forest','Sherry','npc',[141376.000014,16096],{actor:'magma-sherry',facing:'down',source:nativeSource('BP_Larry_Act2_C_2 / BP_Sherry_Act2'),dialogue:['蓝色森林的营地在更深处。遇到交锋之后，记得照顾伙伴的状态。']}),
      portal('ashen-north','繁花森林',[141376,16640],'blooming',[143552,25088],'ashen-clear'),
    ],[25,37,111],[143360,13280]),
  makeMap('blooming','繁花森林','DEMO ISLAND / BLOOMING FOREST','forest','MAP_BloomingForest',
    [135807.9999888,24320.000095190313,-.0002502461720723659],[144512.00015456002,33792.0011020025,.07210749387741089],
    [143552,25088],[
      portal('blooming-south','灰烬森林',[143552,25280],'ashen',[141376,16576]),
      at('blooming-guard','蓝色林地的熔岩队员','trainer',[142016,26272],{actor:'magma-grunt',speciesId:149,rewardFlag:'forest-clear',source:nativeSource('PaperFlipbookActor_18 / BP_MagmaGrunt'),dialogue:['你和伙伴已经经历了不少交锋。就在这片林地，完成最后一场较量吧。','我会全力应战。你也可以先去北面的营地准备。']}),
      at('blooming-camp','繁花森林营地','heal',[142976,30304],{source:nativeSource('BP_Tent_C_1 附近原地形可站立点；恢复功能为 Web 适配'),dialogue:['蓝色的树冠在帐篷上方轻轻摇动。你和伙伴终于可以休息一会儿。']}),
      at('blooming-supplies','林地补给','pickup',[142784,30432],{source:nativeSource('BP_Demo_Shop_C_1；原商店位置，拾取用途为 Web 适配'),dialogue:['营地留有一份旅途补给。获得伤药 ×1。']}),
      at('journey-end','森林中的旅程记录','npc',[142976,30464],{requires:'forest-clear',rewardFlag:'journey-complete',source:nativeSource('BP_Tent_C_1；六区域终点互动为 Web 适配'),dialogue:['从风暴后的海岸，到道路、灰烬与蓝色森林，你和伙伴已经走完了这一段旅程。','这六片原地图仍然向你开放。可以沿来路自由探索，也可以在草地中继续练习配合。','本段 Web 探索完成；原作后续关卡、过场和谜题将继续按源数据接入。']}),
    ],[25,37,117,149],[142976,30304]),
];
export const WORLD_MAP_BY_ID=new Map<string,WorldMap>(WORLD_MAPS.map(map=>[map.id,map]));
export const JOURNEY=[
  {flag:'partner-ready',title:'在海岸醒来',detail:'和身旁的皮特船长交谈，随后向东面的营地出发。'},
  {flag:'route101-clear',title:'穿过海岛道路 101',detail:'在海滩东侧进入道路 101，击败道路上的熔岩队员。'},
  {flag:'route102-clear',title:'走向北面的低地',detail:'继续向东进入道路 102，与低地的熔岩队员交锋。'},
  {flag:'route103-clear',title:'沿林间道路前行',detail:'从道路 102 北侧进入道路 103，赢下林间的交锋。'},
  {flag:'ashen-clear',title:'进入灰烬森林',detail:'沿道路 103 北行，击败灰烬森林的发电机守卫。'},
  {flag:'forest-clear',title:'寻找蓝色的树冠',detail:'穿过灰烬森林北侧出口，完成繁花森林中的交锋。'},
  {flag:'journey-complete',title:'在森林营地停歇',detail:'前往繁花森林北侧的帐篷，阅读旅程记录。'},
];
export function objectiveFor(save:Pick<WorldSave,'flags'|'mapId'>):{flag:string;title:string;detail:string}{
  return JOURNEY.find(step=>!save.flags.includes(step.flag))??{flag:'journey-complete',title:'继续自由探索',detail:'六个区域都已开放。沿来路探索、在营地休息，或继续与伙伴练习交锋。'};
}
