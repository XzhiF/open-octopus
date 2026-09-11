export const workflowEdgeStyles = {
  smoothstep: {
    stroke: "rgba(33, 31, 39, 0.55)",
    strokeWidth: 2,
  },
  condition: {
    stroke: "#ffb800",
    strokeWidth: 2,
  },
  conditionSuccess: {
    stroke: "#00b575",
    strokeWidth: 2,
  },
  conditionFailure: {
    stroke: "#e5484d",
    strokeWidth: 2,
  },
  animated: {
    stroke: "#ffb800",
    strokeWidth: 2,
    animated: true,
  },
}

export const workflowEdgeMarkerEnd = {
  type: "arrowclosed",
  width: 20,
  height: 20,
  color: "rgba(33, 31, 39, 0.55)",
}

export const conditionSuccessMarker = {
  type: "arrowclosed",
  width: 20,
  height: 20,
  color: "#00b575",
}

export const conditionFailureMarker = {
  type: "arrowclosed",
  width: 20,
  height: 20,
  color: "#e5484d",
}