import { EventType } from "../shape/constant";
import { Emitter } from "../util/Emitter";
import { MoveModel, MoveRange, StartMoveSource } from "./MoveModel";
import { ViewModel } from "./ViewModel";
import { ShapeCompManager } from "./shapeManager";
import { SelectionModel } from './SelectionModel'
import { IGraphOption, Shape, ShapeKey, SubShapeType } from "../types";
import { GraphOption } from "../../editor/graphOption";
import { useDrawStore } from "../../editor/store";
import { ResizeModel } from "./ResizeModel";
import { EdgePointMoveModel } from "./EdgePointMoveModel";
import { MarkerModel } from "./MarkerModel";
import { cloneDeep } from "lodash";
import { LabelEditorModel } from "./LabelEditorModel";
import { UpdatePatchItem, batchUpdateShapesService, patchItemFactory } from "../service";
export const emitter = new Emitter()
export class GraphModel {
  disabled = false
  shapes: Set<Shape>
  rootShape = {
    bounds: {
      absX: 12,
      absY: 12
    }
  } as Shape
  /**
 * graph配置对象(暴露的接口，由外部实现)
 */
  graphOption: IGraphOption
  constructor(opt: IGraphOption) {
    this.graphOption = opt;
    this.graphOption.graph = this;
  }
  /**
   * 图形标记（高亮效果）
   */
  markerModel = new MarkerModel(this)
  /**
   * 元素resize模型
   */
  resizeModel = new ResizeModel(this)
  /**
* 线的控制点移动模型
*/
  edgePointMoveModel = new EdgePointMoveModel(this)
  /**
 * 选中元素模型
 */
  selectionModel = new SelectionModel(this)
  /**
 * 视图模型
 */
  viewModel = new ViewModel(this)

  /**
 * 元素移动模型
 */
  moveModel = new MoveModel(this)
  /**
* 标签编辑模型(任何可编辑的标签，比如：模块名称、线的名称)
*/
  labelEditorModel = new LabelEditorModel(this)
  /**
 * 图形id索引
 */
  shapeMap = new Map<string, Shape>()
  /**
 * 事件发射器
 */
  emitter = emitter
  /**
   * 图形组件管理器(当前画布上使用到的那些图形组件)
   */
  shapeCompManager = new ShapeCompManager();
  store = useDrawStore()

  /**
   * children索引， id -> children，(父图形ID对应的其多个子图形)
   */
  indexParent: Map<string | null, Shape[]> = new Map()
  init() {
    this.initEvents()
  }
  initEvents() {
    // 移动事件监听
    this.emitter.on(EventType.SHAPE_MOUSE_DOWN, this.moveModel.startMove.bind(this.moveModel));

    // label 编辑框选中监听
    this.emitter.on(EventType.NAME_LABEL_CLICK, this.labelEditorModel.onShapeNameLabelClick.bind(this.labelEditorModel));
  }
  /**
   * 注册图形组件 {key:组件的subShapeType, comp:vue组件}
   * @param arr
   */
  registerShapeComps(arr: { key: string; comp: any }[]) {
    this.shapeCompManager.addShapes(arr);
  }
  /**
   * 注册图形组件
   * @param arr
   */
  getShapeComp(key: string) {
    return this.shapeCompManager.get(key);
  }
  getShape(id: string): Shape | undefined {
    return this.shapeMap.get(id);
  }
  addShape(shape: Shape) {
    if (this.shapeMap.has(shape.id)) {
      return;
    }
    this.shapeMap.set(shape.id, shape);
  }
  removeShape(id: string) {
    const shape = this.shapeMap.get(id);
    if (shape) {
      this.shapeMap.delete(id);
    }
  }
  /**
 * 移动结束时触发的方法
 * @param moveModel
 * @param dx
 * @param dy
 */
  async customEndMove(moveModel: MoveModel, dx: number, dy: number) {
    // 当数组为空时，得到的时 -Infinity 需要设置最低为0
    const maxZIndex = Math.max(...this.store.shapes.map(item => item.style?.zIndex).filter(item => item !== undefined), 0)
    const valList = []
    // 更新图形位置
    moveModel.movingShapes.forEach((shape: Shape) => {
      const res = patchItemFactory()
      res.oldVal.bounds = shape.bounds
      res.newVal.bounds = {
        ...shape.bounds,
        x: shape.bounds.x + dx,
        y: shape.bounds.y + dy,
        absX: shape.bounds.absX + dx,
        absY: shape.bounds.absY + dy
      }
      res.id = shape.id
      valList.push(res)

      if (shape.subShapeType === SubShapeType.Block) {
        // 查询 shapes 中关联的线，将线的一端进行更新
        this.store.shapes.forEach(s => {
          if (s.subShapeType === SubShapeType.CommonEdge) {
            if (s.sourceId === shape.id) {
              let edgePatch = patchItemFactory()
              const newWaypoint = cloneDeep(s.waypoint)
              // 更新 source 端 point 数据
              const firstPoint = newWaypoint[0]
              firstPoint.x += dx
              firstPoint.y += dy
              edgePatch = {
                oldVal: {
                  waypoint: s.waypoint,
                  bounds: s.bounds
                },
                newVal: {
                  waypoint: newWaypoint,
                  bounds: { // 如果移动的是 source 端，需要调整线的 bounds，名称位置计算会依赖
                    ...s.bounds,
                    absX: firstPoint.x,
                    absY: firstPoint.y
                  }
                },
                id: s.id
              }
              valList.push(edgePatch)
            } else if (s.targetId === shape.id) {
              let edgePatch = patchItemFactory()
              const newWaypoint = cloneDeep(s.waypoint)
              // 更新 target 端 point 数据
              const lastPoint = newWaypoint[s.waypoint.length - 1]
              lastPoint.x += dx
              lastPoint.y += dy
              edgePatch = {
                oldVal: {
                  waypoint: s.waypoint
                },
                newVal: {
                  waypoint: newWaypoint
                },
                id: s.id
              }
              valList.push(edgePatch)
            }
          }
        })
      }
      if (shape.subShapeType === SubShapeType.CommonEdge) {
        // 更新 waypoint 位置
        res.oldVal.waypoint = shape.waypoint
        res.newVal.waypoint = shape.waypoint.map(point => {
          return {
            ...point,
            x: point.x + dx,
            y: point.y + dy
          }
        })
      }
      /** 最新移动的层级最高 */
      const newStyle = shape.style
      const isMax = shape.style.zIndex === maxZIndex
      if (isMax) {
        newStyle.zIndex = maxZIndex
      } else {
        newStyle.zIndex = maxZIndex + 1
      }
      /** 不参与 step 变更记录，直接修改 shape */
      // res.oldVal.style = shape.style
      // res.newVal.style = newStyle
    })
    batchUpdateShapesService(valList)
  }
  getMoveRange(moveShapes: Shape[]): Promise<MoveRange> {
    // 判断是否存在只能沿x或y轴移动的元素，没有考虑上面俩
    let [signX, signY] = [0, 0];
    // 是否有选中元素只能在
    for (let it of moveShapes) {
      signX += it.style?.xOnly ? 1 : 0;
      signY += it.style?.yOnly ? 1 : 0;
    }

    let [dxMin, dyMin, dxMax, dyMax] = [0, 0, Infinity, Infinity];
    let minAbsX = Math.min(...moveShapes.map(it => {
      return it.bounds.absX
    }));
    let minAbsY = Math.min(...moveShapes.map(it => {
      return it.bounds.absY
    }));
    // 能移动 x 轴偏差值如: -200,最小移动 -200
    dxMin = this.rootShape!.bounds.absX - minAbsX;
    dyMin = this.rootShape!.bounds.absY - minAbsY;
    if (signX) dyMin = dyMax = 0;
    if (signY) dxMin = dxMax = 0;
    return Promise.resolve({
      dxMin,
      dyMin,
      dxMax,
      dyMax
    });
  }
}
