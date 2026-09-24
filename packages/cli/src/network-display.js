export const formatNetworkExecution = (network, { routerId, decision, routerSpawned = false } = {}) => {
  const components = new Map(network.components.map((component) => [component.id, component]));
  const shown = new Set();
  const spawnedChild = decision?.child_run_id ? decision.child_component_id : null;
  const lines = [
    `Network ${network.id} (revision ${network.revision || "unversioned"})`,
    "* spawned  . not spawned",
    `principal (catalog: ${network.ego?.catalog || "none"}; logical entry)`,
  ];
  const render = (component, prefix, last, edge) => {
    shown.add(component.id);
    const spawned = (component.id === routerId && routerSpawned) || component.id === spawnedChild;
    const kind = component.catalog ? `catalog: ${component.catalog}` : component.capability ? `capability: ${component.capability}` : `graph: ${component.graph}`;
    const adviser = component.router ? `; adviser: ${component.router.adviser}` : "";
    const chosen = edge?.routeId === decision?.selected_route_id && component.id === decision?.child_component_id;
    const relation = edge?.routeId ? `; route: ${edge.routeId}${chosen ? "; selected" : ""}` : edge?.spawn ? "; spawn" : "";
    const state = component.enabled ? "" : "; disabled";
    lines.push(`${prefix}${last ? "`--" : "|--"} ${spawned ? "*" : "."} ${component.id} (${kind}${adviser}${relation}${state})`);
    const routes = component.router?.routes || [];
    routes.forEach((route, index) => {
      const target = components.get(route.component);
      if (target) render(target, prefix + (last ? "    " : "|   "), index === routes.length - 1, { routeId: route.id });
    });
  };
  const roots = (network.ego?.spawn || []).map((id) => components.get(id)).filter(Boolean);
  roots.forEach((component, index) => render(component, "", index === roots.length - 1, { spawn: true }));
  const detached = network.components.filter((component) => !shown.has(component.id));
  if (detached.length) {
    lines.push("Other components");
    const targets = new Set(detached.flatMap((component) => (component.router?.routes || []).map((route) => route.component)));
    const roots = detached.filter((component) => !targets.has(component.id));
    roots.forEach((component, index) => render(component, "", index === roots.length - 1, null));
  }
  return lines.join("\n") + "\n";
};
