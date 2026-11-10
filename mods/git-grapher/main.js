// One mod with two roles: the graph by default, or a detached detail pane when props.role is "detail".
// Read props() only during init; after an await it can belong to another mod copy.
import { View } from "gpui-kit";
import { props } from "herdr";
import { GraphView } from "./graph.js";
import { DetailPane } from "./detail-main.js";

export default class Ggit extends View {
  init(p, cx) {
    this.part = props()?.role === "detail" ? new DetailPane() : new GraphView();
    this.part.init(p, cx);
  }
  render(cx) { return this.part.render(cx); }
  close() { this.part.close?.(); }
}
