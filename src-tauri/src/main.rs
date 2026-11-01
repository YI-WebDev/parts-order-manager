// 配布版はコンソールを出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() { parts_order_manager_lib::run(); }
