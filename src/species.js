import { SPACE } from './core.js';

/**
 * 品种表：每个物种的准入参数与鱼皮配方。
 *
 * 加一条新鱼 = 在这里加一条记录 + 在 scene.js 里 import 一个 glb。
 * 这里只放"数据"，不放逻辑，方便把参数调优和渲染代码分开。
 *
 * 轴约定（axis）：along = 体长轴，lift = 背腹轴，dorsal = +1 表示该轴正向朝背。
 * 这几项由资产自身的建模朝向决定，不是世界坐标——鱼皮在物体空间做投影，
 * 所以要按资产的实际姿态填。
 */
export const SPECIES = {
  /** 红绿灯：多视角照片参考 + 细长侧扁体形 + 单网格虚拟骨骼，5 条群游。 */
  neonTetra: {
    id: 'neon-tetra',
    name: '红绿灯',
    targetLength: 0.040,          // 4.0 cm，符合小型加拉辛群游鱼的缸内比例
    count: 5,
    facing: -1,                   // 单侧面重建资产的吻端在局部 -X
    axis: { along: 0, lift: 1, dorsal: 1 },
    rig: 'neon-tetra',
    textured: true,
    cruise: 0.82,
    heightBase: 0.103,
    heightStep: 0.022,
    space: SPACE,
  },
  /** 眼斑双锯鱼：照片重建网格 + 分区鳍权重 + 脊柱弯曲，行动由 ClownfishPilot 驱动。 */
  clownfish: {
    id: 'clownfish',
    name: '小丑鱼',
    targetLength: 0.062,
    count: 2,
    facing: -1,
    axis: { along: 0, lift: 1, dorsal: 1 },
    rig: 'clownfish',
    cruise: 0.56,
    heightBase: 0.095,
    heightStep: 0.052,
    space: SPACE,
  },
};
