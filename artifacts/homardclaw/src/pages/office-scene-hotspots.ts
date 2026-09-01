export interface SceneHotspot {
  href: string;
  label: string;
  ariaLabel: string;
  /** Centre position in the submarine artwork, expressed as a percentage. */
  left: string;
  top: string;
  /** Hit-area dimensions as percentages of the artwork. */
  width: string;
  height: string;
  extraClass?: string;
}

export const SCENE_HOTSPOTS: SceneHotspot[] = [
  {
    href: "/tasks",
    label: "Tasks",
    ariaLabel: "Task whiteboard — open Tasks",
    left: "18.5%",
    top: "35.2%",
    width: "11.5%",
    height: "14%",
  },
  {
    href: "/schedules",
    label: "Schedules",
    ariaLabel: "Wall calendar — open Schedules",
    left: "26.7%",
    top: "34.8%",
    width: "5.8%",
    height: "12%",
  },
  {
    href: "/inbox",
    label: "Inbox",
    ariaLabel: "Blue navigation console — open Inbox",
    left: "25.8%",
    top: "44.6%",
    width: "10%",
    height: "9%",
  },
  {
    href: "/approvals",
    label: "Approvals",
    ariaLabel: "Command console — open Approvals",
    left: "19.6%",
    top: "49.5%",
    width: "4.2%",
    height: "4.5%",
    extraClass: "scene-hotspot--approval",
  },
  // Crustabot and Team navigation lives on two unused instrument banks in the
  // port control console. The four wall computers are workstations only.
  // Both banks open the Crustabots page — Teams lands on its Teams tab —
  // since team navigation now lives inside the Crustabot menu.
  {
    href: "/agents",
    label: "Crustabots",
    ariaLabel: "Left server instrument bank — open Crustabots",
    left: "12.8%",
    top: "47.7%",
    width: "5.2%",
    height: "8.4%",
    extraClass: "scene-hotspot--console",
  },
  {
    href: "/agents?tab=teams",
    label: "Teams",
    ariaLabel: "Centre server instrument bank — open Teams",
    left: "16.7%",
    top: "45.8%",
    width: "3.6%",
    height: "6.5%",
    extraClass: "scene-hotspot--console",
  },
  {
    href: "/connected-apps",
    label: "Apps",
    ariaLabel: "Purple apps rack — open Connected Apps",
    left: "74.5%",
    top: "40.8%",
    width: "13.5%",
    height: "16%",
  },
  {
    href: "/reports",
    label: "Reports",
    ariaLabel: "Leftmost blue server cabinet — open Reports",
    left: "68.3%",
    top: "59.2%",
    width: "3.7%",
    height: "11.5%",
  },
  {
    href: "/providers",
    label: "Providers",
    ariaLabel: "Blue data centre — open Providers",
    // Starts to the right of the first cabinet, which now opens Reports, and
    // stops at the cabinet feet so the clear floor remains visually clear.
    left: "79%",
    top: "59.2%",
    width: "16%",
    height: "11.5%",
  },
  {
    href: "/memory",
    label: "Memory",
    ariaLabel: "Small upper computer — open Memory",
    left: "82.2%",
    top: "44.6%",
    width: "6.8%",
    height: "10.5%",
    extraClass: "scene-hotspot--terminal",
  },
  {
    href: "/documentation",
    label: "Documentation",
    ariaLabel: "Small library — open Documentation",
    left: "86.7%",
    top: "48%",
    width: "5.5%",
    height: "11.5%",
  },
  {
    href: "/island",
    label: "Retirement Island",
    ariaLabel: "Porthole — open Retirement Island",
    left: "88.5%",
    top: "39.5%",
    width: "6.5%",
    height: "11%",
  },
];
