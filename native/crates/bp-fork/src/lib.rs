//! Fork planning for buildplane. Consumes bp-replay state to build a
//! ForkPlan that describes how to resume from a unit boundary in a prior run.

pub mod plan;
pub mod planner;

pub use plan::ForkPlan;
pub use planner::{build_fork_plan, PlanError};
