import { createText, createDom } from './h'

let currentRoot = null               // 上一次的根fiber
let workInProgressRoot = null        // 当前处理的根fiber，workloop的开始
let nextUnitOfWork = null            // 下一个要处理的fiber, 用全局变量记录，下次循环从这里开始
let deletions = []                   // 被标记delete的fiber
let wipFiber = null                  // 记录当前function组件这个fiber
let hookIndex = 0                    // 记录当前function组件里，第N个hook

export function render(vnode, container) {
    workInProgressRoot = {
        dom: container,
        props: { children: [vnode] },
        done: () => {}
    }

    nextUnitOfWork = workInProgressRoot
    requestIdleCallback(workloop)
}

const workloop = (deadline) => {
    // 有任务且没超时
    while(nextUnitOfWork && deadline.timeRemaining() > 1) {
        nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    }

    // 有任务, 但超时了
    if(nextUnitOfWork) {
        requestIdleCallback(workloop)
    }

    // 无任务, 最后执行commit
    if(!nextUnitOfWork && workInProgressRoot) {
        commitRoot()
    }
}

// 处理当前fiber, 并返回下一个fiber
const performUnitOfWork = (fiber) => {
    if(isFn(fiber.type)) {
        updateFunctionComponent(fiber)
    } else {
        updateHostComponent(fiber)
    }
    // 深度优先遍历, 有child返回child, 无child返回sibling, 也无sibling, 继续找其父节点的sibling
    if(fiber.child) {
        return fiber.child
    }
    if(fiber.sibling) {
        return fiber.sibling
    }
    while(fiber = fiber.return) {
        if(fiber.sibling) {
            return fiber.sibling
        }
    }
}

const updateFunctionComponent = (fiber) => {
    // 标记wipFiber, 等下执行到组件里的useState的时候就用这个wipFiber 
    wipFiber = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const children = [fiber.type(fiber.props)]
    reconcileChildren(fiber, children)
}

const updateHostComponent = (fiber) => {
    if(!fiber.dom) {
        fiber.dom = createDom(fiber)
    }
    const children = fiber.props && fiber.props.children
    reconcileChildren(fiber, children)
}

// 标记处理children这一层, 将children转换成fiber结构
// 添加父 -> 第一个子child属性；子 -> 父return 属性；子 -> 兄弟sibling属性 
const reconcileChildren = (fiber, children = []) => {
    if(children.length == 0) {
        return false
    }

    // 父fiber的第一个child
    let oldFiber = fiber.alternate && fiber.alternate.child

    // 如果不存在，说明
    if(!oldFiber) {
        let preSibling = null
        for(let i = 0; i < children.length; i++) {
            let element = children[i]
            let newFiber = createNewFiber(element, fiber)
            if(i == 0) {
                fiber.child = newFiber
            } else {
                preSibling && (preSibling.sibling = newFiber)
            }
            preSibling = newFiber
        }
    }

    // 存在oldFiber的情况
    let j = 0
    let preSibling = null
    while(j < children.length || oldFiber) {
        if(!oldFiber) {
            return false
        }
        let newFiber = null
        let element = children[j]
        const sameType = oldFiber && element && oldFiber.type === element.type

        // type相同，可复用，更新即可
        if(sameType) {
            newFiber = {
                type: oldFiber.type,
                props: element.props,
                dom: oldFiber.dom,
                return: fiber,
                alternate: oldFiber,          // 记录下上次状态
                effectTag: 'UPDATE'           // 添加一个操作标记
            }
        } else if(element) {
            // 类型不一样，有新节点，创建
            newFiber = createNewFiber(element, fiber)
        } else if(oldFiber) {
            oldFiber.effectTag = 'DELETE'
            deletions.push(oldFiber)
        }

        // 比较下一个oldFiber
        oldFiber = oldFiber.sibling
        if(j === 0) {
            fiber.child = newFiber
        } else {
            preSibling && (preSibling.sibling = newFiber)
        }
        preSibling = newFiber
        j++
    }
}

const createNewFiber = (fiber, parent) => {
    return {
        type: fiber.type,
        props: fiber.props,
        dom: null,
        return: parent,
        alternate: null,
        effectTag: 'PLACE'
    }
}

export function useState (initState) {
    const oldHook = wipFiber.alternate && wipFiber.alternate.hooks && wipFiber.alternate.hooks[hookIndex]
    const hook = {
        state: oldHook ? oldHook.state : initState
    }
    // 多次useState的时候，将每个hook按顺序放入数组
    wipFiber.hooks.push(hook)
    hookIndex++

    const setState = (state) => {
        hook.state = state
        workInProgressRoot = {
            dom: currentRoot.dom,
            props: currentRoot.props,
            alternate: currentRoot
        }

        nextUnitOfWork = workInProgressRoot
        requestIdleCallback(workloop)
    }

    return [hook.state, setState]
}

const commitRoot = () => {
    deletions.forEach(commitRootImpl)
    commitRootImpl(workInProgressRoot.child)
    currentRoot = workInProgressRoot
    workInProgressRoot = null
    deletions = []
}

const commitRootImpl = (fiber) => {
    if(!fiber) {
        return
    }

    let parentFiber = fiber.return
    while(!parentFiber.dom) {
        parentFiber = parentFiber.return
    }
    const parentDom = parentFiber.dom

    if(fiber.effectTag === 'PLACE' && fiber.dom) {
        parentDom.appendChild(fiber.dom)
    } else if(fiber.effectTag === 'DELETE') {
        commitDeletion(fiber, parentDom)
    } else if(fiber.effectTag === 'UPDATE' && fiber.dom) {
        // 更新DOM属性
        updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    }

    // 递归操作子元素和兄弟元素
    commitRootImpl(fiber.child)
    commitRootImpl(fiber.sibling)
}

const commitDeletion = (fiber, domParent) => {
    if(fiber.dom) {
      // dom存在，是普通节点
      domParent.removeChild(fiber.dom);
    } else {
      // dom不存在，是函数组件,向下递归查找真实DOM
      commitDeletion(fiber.child, domParent);
    }
}

const updateDom = (dom, prevProps, nextProps) => {
    Object.keys(prevProps)
        .filter(name => name !== 'children')
        .filter(name => !(name in nextProps))
        .forEach(name => {
            if(name.indexOf('on') === 0) {
            dom.removeEventListener(name.substr(2).toLowerCase(), prevProps[name], false);
            } else {
            dom[name] = '';
            }
        });
  
    Object.keys(nextProps)
        .filter(name => name !== 'children')
        .forEach(name => {
            if(name.indexOf('on') === 0) {
            dom.addEventListener(name.substr(2).toLowerCase(), nextProps[name], false);
            } else {
            dom[name] = nextProps[name];
            }
        });
}

const isFn = (fn) => (typeof fn === 'function')