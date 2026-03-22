import React from "react";
import { classNames as cx } from "@/utils/css";

const COLUMNS = {
  1: "grid-cols-1",
  2: "grid-cols-1 md:grid-cols-2",
  3: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
};

export default function DashboardGrid({ columns = 3, gap = "gap-4", className, children }) {
  return (
    <section className={cx("grid", COLUMNS[columns] || COLUMNS[3], gap, className)}>
      {children}
    </section>
  );
}
