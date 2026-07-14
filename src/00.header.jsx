import React from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import * as Astryx from "@astryxdesign/core";
const ReactDOM = { createRoot, createPortal };
window.React = React; window.ReactDOM = ReactDOM; window.Astryx = Astryx;
const {useState,useEffect,useRef,useCallback,useMemo}=React;
