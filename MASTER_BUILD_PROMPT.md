# MASTER BUILD PROMPT: A Production-Quality Browser-Based Orbital Engineering Game

You are the lead game designer, technical director, engine architect, physics programmer, graphics programmer, tools engineer, UI/UX designer, gameplay programmer, audio director, QA lead, performance engineer, and producer for this project.

Your job is not to produce a concept, mockup, static demo, landing page, or shallow prototype.

Your job is to design, implement, test, profile, polish, and deliver a genuinely playable single-player web game centered on spacecraft engineering, physically grounded flight, orbital mechanics, exploration, scientific discovery, and off-world expansion.

The game should capture the freedom, emergent problem-solving, educational value, and joyful failures associated with the best orbital-engineering sandbox games, while being a completely original product.

⸻

## 1. Non-Negotiable Legal and Creative Distinction

This game may be inspired by the broad genre and design principles of Kerbal Space Program and its modding community, but it must not be a direct clone.

You must:

* Create an original game title.
* Create an original astronaut species, visual identity, culture, personality, animation language, and naming conventions.
* Create an original star system, celestial bodies, geography, lore, space agency, progression structure, interface, part designs, icons, audio, music, writing, missions, and visual style.
* Use no Kerbal, KSP, Kerbin, Mün, Minmus, Jool, or other protected names.
* Use no copied models, textures, code, sounds, music, UI layouts, missions, text, logos, or proprietary assets.
* Do not imitate KSP's characters closely enough to cause confusion.
* Use only original assets, procedurally generated assets, or properly licensed dependencies and source material.
* Maintain ATTRIBUTIONS.md and LICENSES.md.
* Record the license, source, and permitted use of every external dependency and asset.

The final product should feel like a major new entry in the orbital-engineering genre, not an unauthorized recreation.

⸻

## 2. Operating Instructions

Work as an autonomous senior development team.

Do not respond with only a plan. After establishing the architecture, begin implementation immediately.

Use this operating loop:

1. Inspect the repository and available environment.
2. Identify technical constraints.
3. Create a concise architecture decision record.
4. Build a measurable technical prototype for the riskiest systems.
5. Select the stack based on measured evidence.
6. Implement a complete vertical slice.
7. Run automated tests.
8. Run the game in a real browser.
9. Play the game yourself through the primary gameplay loop.
10. Profile CPU, GPU, memory, loading, and garbage collection.
11. Record the most serious defects.
12. Fix them.
13. Repeat the test, play, profile, and improvement cycle.
14. Expand the game through the milestones defined below.
15. Do not declare the project complete until every required acceptance gate passes.

Reason deeply internally, but report decisions through concise rationale, architecture documents, test output, measurements, and working software rather than lengthy speculation.

Resolve ordinary ambiguities using sound engineering judgment. Do not repeatedly ask the user to choose libraries, naming details, colors, or minor design decisions.

Never conceal missing functionality. Never represent a scripted animation, fake UI value, placeholder interaction, or precomputed demonstration as a working simulation.

⸻

## 3. Product Vision

Build an original single-player game in which the player runs a growing space program.

The emotional arc should be:

Imagine → Design → Analyze → Build → Launch → Fail → Learn → Reach orbit → Explore → Discover → Industrialize → Automate mastered work → Expand into a spacefaring civilization.

The game must combine:

* Intuitive construction.
* Deep engineering.
* Credible physics.
* Emergent failures.
* Approachable learning tools.
* Spectacular planetary visuals.
* Strong progression.
* Meaningful exploration.
* Long-term logistical strategy.
* Excellent performance.
* Fast iteration between design and flight.

The game should respect both beginners and aerospace enthusiasts. It must offer approachable defaults without eliminating advanced simulation.

The player should be able to enjoy it as:

* A creative vehicle sandbox.
* An orbital-mechanics learning environment.
* A challenging space-program campaign.
* A scientific exploration game.
* A colony and logistics game.
* A programmable automation game.
* A cinematic spaceflight experience.

It is strictly single-player. Do not spend development effort on multiplayer networking, server authority, matchmaking, accounts, competitive systems, or multiplayer synchronization.

⸻

## 4. Design Pillars

Every feature must support at least one of these pillars.

### 4.1 Engineering Has Consequences

Vehicles fly according to their mass, shape, propulsion, control authority, structural design, thermal protection, energy systems, resource capacity, and mission environment.

The editor must show enough information for the player to understand likely problems before launch.

### 4.2 Physics Produces Stories

Successful missions and disasters must emerge from simulation rather than canned sequences.

Failures should be understandable. The player should be able to inspect what happened and improve the design.

### 4.3 Learning Without Homework

Expose real concepts such as:

* Delta-v.
* Thrust-to-weight ratio.
* Specific impulse.
* Apoapsis and periapsis.
* Inclination.
* Transfer windows.
* Atmospheric drag.
* Center of mass.
* Center of pressure.
* Thermal load.
* Communications geometry.
* Power budgets.
* Structural loads.

Explain them contextually through visualization and interaction rather than walls of text.

### 4.4 Exploration Must Reveal Something

New locations should contain scientific, navigational, environmental, historical, or resource discoveries.

Landing on a new world must involve more than pressing a science button several times.

### 4.5 Mastery Reduces Repetition

The player should manually learn important flight operations. Once a task has been demonstrated reliably, optional automation should remove repetitive busywork.

Automation must expand the player's ambitions rather than replace the core game immediately.

### 4.6 Beauty Cannot Be Purchased With Choppiness

Graphics must be ambitious, but visual effects must scale intelligently.

A stable frame rate, responsive controls, consistent frame pacing, and fast loading take priority over an effect that only looks good in screenshots.

⸻

## 5. Technical Architecture

You may choose the final stack, but you must evaluate it against performance, browser support, maintainability, development speed, numerical precision, asset delivery, and debugging.

### 5.1 Preferred Architecture to Evaluate First

Use this as the default candidate unless testing demonstrates a better approach:

* TypeScript for the application shell, editor tooling, UI, content pipeline, and browser integration.
* A WebGPU-capable rendering engine such as Babylon.js, or a custom WebGPU renderer when justified.
* WebGL2 fallback for unsupported devices.
* Rust compiled to WebAssembly for orbital mechanics, vessel simulation, resource simulation, structural analysis, trajectory prediction, and other hot numerical systems.
* A web-compatible rigid-body library such as Rapier for contact resolution, collision queries, wheels, and selected joints.
* Custom vessel-graph, structural, orbital, aerodynamic, and resource systems rather than expecting a generic rigid-body engine to solve every problem.
* Web Workers for simulation, terrain generation, trajectory analysis, asset preparation, and other CPU-heavy tasks.
* SharedArrayBuffer where supported and correctly secured, with a message-passing fallback.
* Offscreen rendering or worker-based rendering when supported and measurably beneficial.
* A lightweight UI framework or direct DOM system. Do not rerender the high-frequency flight HUD through a heavyweight application framework every frame.
* Vite or an equivalent fast build system.
* IndexedDB for local saves and cached generated data.
* glTF for models, KTX2/Basis Universal for textures, and mesh compression where appropriate.
* A data-oriented entity/component architecture for simulation-heavy systems.

You may replace this stack only after documenting and benchmarking a stronger option.

### 5.2 Mandatory Separation of Concerns

Separate these layers:

* Simulation state.
* Rendering state.
* UI state.
* Persistent save state.
* Content definitions.
* Input abstraction.
* Audio.
* Mission logic.
* Mod or user-content interfaces.

The render loop must never be the authoritative simulation clock.

Use a fixed or controlled simulation timestep and interpolation for rendering.

### 5.3 Numerical Scale

Spaceflight spans millimeters to astronomical distances. Design for this from the beginning.

Implement:

* Double-precision authoritative positions and velocities where needed.
* Hierarchical celestial and local reference frames.
* Camera-relative rendering.
* Floating origins.
* Local physics bubbles.
* Stable transitions between reference frames.
* Clear unit conventions.
* Tests for precision at planetary and interplanetary scales.

Never store the entire universe directly as ordinary single-precision world coordinates.

⸻

## 6. Physics Architecture

### 6.1 Two-Regime Simulation

Use two complementary regimes.

**Active Physics**

Used for:

* The controlled vessel.
* Nearby vessels.
* Docking.
* Landing.
* Atmospheric flight.
* Collisions.
* Robotics.
* Surface vehicles.
* Debris that can affect the player.

**Analytic or Background Propagation**

Used for:

* Distant spacecraft.
* Stable orbits.
* Long-duration transfers.
* Colony production.
* Resource processing.
* Communications.
* Scientific experiments.
* Automated routes.
* Crew and mission timers.

Do not run full rigid-body physics for every object in the star system.

Switch safely between regimes without teleportation, energy explosions, spontaneous vessel destruction, or save corruption.

### 6.2 Orbital Mechanics

The standard simulation must support:

* Elliptical, parabolic, and escape trajectories.
* Spheres of influence or another clear and efficient orbital-domain model.
* Accurate position and velocity propagation.
* Rotating planets.
* Inclined orbits.
* Axial tilt.
* Eclipses.
* Planet and moon ephemerides.
* Maneuver planning.
* Intercepts.
* Rendezvous.
* Docking.
* Aerobraking and atmospheric entry prediction.

Use patched conics or an equivalent efficient model as the normal gameplay mode.

Provide an optional advanced orbital mode that can model selected n-body effects, Lagrange-region behavior, orbital perturbations, or binary systems without forcing the full cost on every player.

### 6.3 Vessel Structural Model

Do not model every ordinary part connection as a weak spring.

Represent a vessel as a structural graph.

* Weld ordinary rigid attachments into stable compound clusters.
* Preserve per-part mass, resources, heat, damage, staging, and functionality.
* Use explicit physical joints only for docking ports, hinges, pistons, rotors, suspension, decouplers, and intentionally flexible elements.
* Calculate bending, compression, tension, torsion, and connection load through a simplified structural solver.
* Permit structural failure under excessive loads.
* Show the player why a connection failed.
* Avoid "noodle rockets," micro-oscillation, and joint-induced frame-rate collapse.
* Support large ships without needing hundreds of unstable iterative joints.
* Permit optional structural reinforcement, struts, load-bearing trusses, and engineering overlays.

### 6.4 Aerodynamics

Implement shape-aware aerodynamics influenced by the strengths of advanced aerospace mods.

At minimum, account for:

* Exposed cross-sectional area.
* Shielding and occlusion.
* Vehicle orientation.
* Angle of attack.
* Sideslip.
* Mach regime.
* Air density.
* Lift.
* Induced drag.
* Wave drag or a practical approximation.
* Body lift.
* Control surfaces.
* Stalls.
* Engine intake requirements.
* Fairings.
* Cargo bays.
* Parachutes.
* Atmospheric heating.
* Wind.
* Atmospheric composition where relevant.

Use a performant approach such as:

* Voxelized shape analysis performed only when vehicle geometry changes.
* Projected-area sampling.
* Simplified aerodynamic coefficient surfaces.
* Cached aero models.
* A hybrid of these techniques.

Aerodynamic analysis must not be recomputed from scratch every frame.

### 6.5 Thermodynamics

Model:

* Convective heating.
* Radiative heating and cooling.
* Conductive transfer.
* Reentry heating.
* Engine heat.
* Solar heating.
* Shadows and eclipses.
* Radiators.
* Heat shields and ablation.
* Cryogenic boil-off in advanced difficulty.
* Part temperature limits.
* Internal thermal loops for advanced reactors and engines.

Thermal simulation must be configurable and visually legible.

### 6.6 Propulsion and Resources

Support:

* Solid rockets.
* Pressure-fed chemical engines.
* Pump-fed chemical engines.
* Liquid-fuel rockets.
* Jet engines.
* Air-breathing combined-cycle engines.
* Monopropellant thrusters.
* Ion or electric propulsion.
* Nuclear thermal propulsion.
* Advanced late-game propulsion.
* Variable engine ignition and throttle characteristics.
* Fuel mixture ratios.
* Engine gimbal.
* Atmospheric nozzle performance.
* Dynamic plume expansion.
* Optional ullage, ignition limits, reliability, and realistic propellant modes.

### 6.7 Surface Physics

Implement robust:

* Landing legs.
* Wheels.
* Suspension.
* Rover steering.
* Braking.
* Friction.
* Slopes.
* Water interaction.
* Buoyancy.
* Aircraft landing gear.
* Ground anchoring for bases.
* Collision-safe terrain loading.

Surface craft should not bounce into the sky when a save is loaded.

⸻

## 7. Vehicle Construction Editor

The editor is one of the game's central experiences and must feel professional.

### 7.1 Essential Construction Features

Implement:

* Drag-and-drop assembly.
* Attachment nodes.
* Surface attachment.
* Radial symmetry.
* Mirror symmetry.
* Angle snap.
* Fine placement.
* Fine rotation.
* Local and global transforms.
* Multi-select.
* Copy and paste.
* Undo and redo.
* Search.
* Filters.
* Favorites.
* Part categories.
* Subassemblies.
* Reusable templates.
* Multiple independent vehicles in one workspace.
* Staging.
* Stage reordering.
* Action groups.
* Abort sequence.
* Resource routing.
* Fuel priority.
* Crew assignment.
* Payload definition.
* Fairing construction.
* Paint, materials, decals, and agency markings.
* Craft naming and version history.
* Import and export of original craft files.
* Autosave and crash recovery.

### 7.2 Procedural Construction

Include performant procedural systems for:

* Fuel tanks.
* Structural tubes.
* Fairings.
* Wings.
* Control surfaces.
* Heat shields.
* Radiators.
* Trusses.
* Colony foundations where appropriate.

Procedural parts must have constraints and costs so that they supplement rather than trivialize the part library.

### 7.3 Engineering Information

Display accurate, continuously updated estimates for:

* Total mass.
* Dry mass.
* Propellant mass.
* Cost.
* Crew capacity.
* Delta-v per stage.
* Total delta-v.
* Thrust-to-weight ratio by stage and environment.
* Burn time.
* Center of mass.
* Wet and dry center-of-mass movement.
* Center of thrust.
* Center of lift or pressure.
* Drag.
* Static stability.
* Control authority.
* Electrical generation and consumption.
* Battery endurance.
* Thermal generation and rejection.
* Communications range.
* Life-support endurance when enabled.
* Structural weak points.
* Landing-leg loading.
* Wheel loading.
* Estimated mission capability.

Let the player evaluate the vessel under configurable conditions:

* Selected celestial body.
* Surface or altitude.
* Atmospheric pressure.
* Full or depleted propellant.
* Different stages.
* Vacuum.
* Expected payload.
* Expected mission duration.

### 7.4 Engineer Advisor

Create an optional engineering advisor that reports specific, actionable warnings such as:

* No control authority after stage separation.
* Center of pressure ahead of the center of mass.
* Insufficient battery endurance during eclipse.
* Landing gear overloaded.
* Antenna cannot reach the intended network.
* Heat rejection is inadequate.
* A later stage is blocked by a fairing or cargo bay.
* Fuel is inaccessible because of routing.
* Crew lacks enough mission endurance.
* Docking ports are obstructed.
* Thrust-to-weight ratio is too low for the selected body.
* A decoupler will detach an unintended part of the craft.

The advisor must explain the reasoning and allow warnings to be ignored.

⸻

## 8. Flight Experience

Implement a complete real-time flight experience with:

* Throttle.
* Staging.
* Pitch, yaw, and roll.
* Trim.
* RCS translation.
* Reaction wheels.
* Engine gimbal.
* SAS modes.
* Action groups.
* Camera modes.
* Map view.
* Cockpit or internal view.
* EVA.
* Boarding.
* Ladders.
* Surface interaction.
* Docking.
* Refueling.
* Crew transfer.
* Resource transfer.
* Repairs.
* Science operations.
* Time warp.
* Limited physical time warp.
* Quicksave.
* Quickload.
* Revert-to-editor and revert-to-launch options where appropriate.
* Flight replay and event timeline.

Controls must remain responsive even when the frame rate temporarily drops.

Provide keyboard, mouse, and gamepad support through a remappable input abstraction.

⸻

## 9. Navigation and Mission Planning

Build the planning tools that experienced players repeatedly install as mods.

### 9.1 Map View

Show:

* Orbits.
* Predicted trajectories.
* Apoapsis and periapsis.
* Ascending and descending nodes.
* Closest approach.
* Encounter markers.
* Maneuver nodes.
* Communication links.
* Sensor coverage.
* Resource scans.
* Colony and station locations.
* Surface waypoints.
* Known anomalies.
* Mission events.
* Alarm markers.

The interface must remain clear with many active missions.

### 9.2 Maneuver Planner

Support:

* Prograde, retrograde, normal, antinormal, radial, and antiradial controls.
* Direct numeric entry.
* Fine adjustment.
* Coarse adjustment.
* Drag handles.
* Next-orbit and previous-orbit selection.
* Maneuvers without requiring current fuel.
* Multiple planned maneuvers.
* Finite-burn estimates.
* Split burns.
* Low-thrust planning.
* Automatic burn-start calculation.
* Predicted remaining propellant.
* Predicted communications and power state during the burn.

### 9.3 Transfer Planner

Include:

* Transfer-window visualization.
* Porkchop plots.
* Ejection-angle guidance.
* Phase-angle guidance.
* Departure and arrival delta-v.
* Travel time.
* Inclination cost.
* Aerobraking options.
* Return-window planning.
* Mission-duration estimate.
* Saved plans.
* Alarm creation.

### 9.4 Atmospheric Trajectory Prediction

Predict:

* Atmospheric entry path.
* Drag-adjusted trajectory.
* Planetary rotation.
* Approximate lift.
* Parachute deployment.
* Landing location.
* Aerobraking result.
* Thermal load.
* Impact velocity.
* Uncertainty caused by weather.

Update the prediction as the craft configuration changes.

### 9.5 Mission Alarm System

Create an integrated alarm and scheduling system for:

* Maneuver nodes.
* Transfer windows.
* Sphere-of-influence transitions.
* Atmospheric entry.
* Science completion.
* Communications windows.
* Battery depletion.
* Life-support limits.
* Construction completion.
* Research completion.
* Colony shortages.
* Automated-route departures.
* Custom player events.

Time warp must slow or stop safely before important events.

⸻

## 10. Progression and Game Modes

Provide at least three modes.

### 10.1 Creative Sandbox

* All ordinary parts unlocked.
* Unlimited funding.
* Configurable science and crew systems.
* Full editor access.
* Optional advanced parts.
* All automation can be enabled.
* Simulation difficulty remains configurable.

### 10.2 Exploration Mode

* Scientific discoveries unlock technology.
* Guided missions provide direction.
* No punishing economy.
* Designed for players who want progression without financial pressure.

### 10.3 Space Program Mode

Include:

* Funding.
* Reputation.
* Research.
* Technology development.
* Facility expansion.
* Crew recruitment.
* Crew training.
* Mission contracts.
* Program objectives.
* Construction and integration time as an optional difficulty setting.
* Testing and simulation costs.
* Vehicle recovery and reuse.
* Insurance or failure consequences.
* Public-interest or sponsor systems where useful.
* Long-term strategic choices.

Do not make the campaign depend on repetitive procedurally generated contracts.

Provide authored mission arcs, milestone goals, emergent opportunities, and player-created missions.

⸻

## 11. Scientific Exploration

Science must not primarily be a repeated "click experiment in every biome" loop.

Implement:

* Instruments with operating conditions.
* Experiments that collect data over time.
* Background experiment processing.
* Limited data storage.
* Transmission bandwidth.
* Data compression.
* Sample collection.
* Sample return.
* Laboratory analysis.
* Surface stations.
* Seismology.
* Atmospheric surveys.
* Orbital mapping.
* Radar mapping.
* Resource scanning.
* Telescopes.
* Radiation measurement.
* Magnetosphere or plasma studies.
* Weather observations.
* Long-baseline observations.
* Rover field science.
* Robotic arms.
* Drill cores.
* Anomaly investigation.

Science should reveal useful information:

* Better terrain maps.
* Atmospheric profiles.
* Resource maps.
* Weather forecasts.
* Radiation environments.
* Gravitational parameters.
* Surface composition.
* Safer landing zones.
* Points of interest.
* New engineering options.
* Story discoveries.

Include:

* A science journal.
* Discovery history.
* Experiment checklist.
* Body-specific progress pages.
* Sample collection.
* A museum or archive displaying important recovered samples, vehicles, photographs, and program milestones.

⸻

## 12. Crew and EVA

Create an original astronaut population with individual:

* Names.
* Appearance.
* Traits.
* Skills.
* Experience.
* Mission history.
* Awards.
* Preferences or morale modifiers where useful.

Support specializations such as:

* Pilot.
* Engineer.
* Scientist.
* Medic or habitation specialist.
* Automation specialist.
* Colony specialist.

Implement:

* EVA movement.
* Tethers or safety options.
* Surface interaction.
* Repair.
* Part replacement.
* Resource connection.
* Sample collection.
* Construction.
* Inventory.
* Deployable experiments.
* Navigation markers.
* Follow commands for nearby crew.
* Group boarding and transfer.

EVA construction should support useful editor tools, including alignment, snapping, and limited symmetry.

⸻

## 13. Life Support, Health, Radiation, and Reliability

These systems must be modular difficulty options.

### 13.1 Default Life Support

The default system should be understandable at a glance and avoid constant micromanagement.

Use a consolidated endurance concept such as "mission supplies," while internally allowing richer simulation.

Provide:

* Clear remaining-duration estimates.
* Grace periods.
* Planner integration.
* Alarm integration.
* Recycling.
* Habitation.
* Greenhouses.
* Local resource production.
* Colony self-sufficiency.
* Background processing.

Default failure consequences should be recoverable, such as:

* Crew hibernation.
* Reduced performance.
* Loss of control.
* Morale collapse.
* Forced rescue.

Permadeath can be enabled in harder modes.

### 13.2 Advanced Life Support

Optionally model:

* Food.
* Water.
* Oxygen.
* Waste.
* Carbon dioxide.
* Pressure.
* Habitable volume.
* Stress.
* Radiation dose.
* Shielding.
* Artificial gravity.
* Medical risk.
* Long-duration isolation.

### 13.3 Reliability

Provide an optional reliability system based on:

* Part quality.
* Tested flight history.
* Operating time.
* Thermal stress.
* Vibration.
* Overstress.
* Maintenance.
* Manufacturing tier.
* Reuse.

Avoid arbitrary, unavoidable random failure.

The player must receive warning signs, mitigation options, inspection data, redundancy choices, and meaningful maintenance decisions.

⸻

## 14. Communications and Remote Operations

Implement a communications network with:

* Line of sight.
* Occlusion.
* Antenna range.
* Antenna direction where enabled.
* Relay satellites.
* Bandwidth.
* Power consumption.
* Signal strength.
* Data transmission.
* Network visualization.
* Multiple ground stations.
* Colony communication infrastructure.

Difficulty options may add:

* Speed-of-light command delay.
* Blackout during atmospheric entry.
* Antenna pointing.
* Interference.
* Limited command capability without a link.

Provide a flight computer that can queue commands for delayed probes.

A disconnected probe should retain safe-mode behaviors and previously uploaded plans rather than becoming useless without explanation.

⸻

## 15. Automation and Programming

Automation must be powerful, optional, transparent, and earned through play.

### 15.1 Built-In Flight Assistance

Provide assistance for:

* Attitude hold.
* Heading and pitch hold.
* Altitude hold for aircraft and VTOLs.
* Speed hold.
* Maneuver-node orientation.
* Maneuver execution.
* Ascent guidance.
* Landing assistance.
* Rendezvous assistance.
* Docking assistance.
* Rover route following.
* Reusable-booster recovery.

Keep basic stability assistance available early.

Gate advanced automation through:

* Training.
* Research.
* Successful manual milestones.
* Program upgrades.
* Difficulty settings.

Sandbox players may enable everything immediately.

### 15.2 Programmable Flight Computer

Create a safe, deterministic automation environment inspired by educational spacecraft scripting.

Provide both:

* A visual node or block interface for beginners.
* A compact text language for advanced players.

Expose documented APIs for:

* Sensors.
* Attitude.
* Throttle.
* Staging.
* Action groups.
* Navigation.
* Maneuver nodes.
* Resources.
* Communications.
* Robotics.
* Science.
* Colony systems.

Execute scripts in a sandboxed worker with:

* Instruction budgets.
* Memory limits.
* Deterministic timing.
* Useful error messages.
* Step debugging.
* Telemetry charts.
* No unrestricted eval.
* No filesystem, network, or browser privilege escalation.

Include tutorial programs for launch control, hovering, landing, and rover navigation.

⸻

## 16. Colonies, Industry, and Logistics

Colonies must support spaceflight rather than replace it.

### 16.1 Colony Construction

Support:

* Surface outposts.
* Orbital stations.
* Resource depots.
* Research installations.
* Communication stations.
* Shipyards.
* Habitats.
* Power plants.
* Refineries.
* Greenhouses.
* Launch facilities.
* Landing pads.
* Storage.
* Transportation hubs.

Do not simulate every permanent colony building as a loose vessel assembled from hundreds of ordinary physics joints.

Use anchored, optimized colony structures while retaining construction constraints, terrain requirements, structural loads, and damage.

### 16.2 Resource System

Include discoverable resources used for:

* Propellants.
* Construction materials.
* Life support.
* Nuclear fuels.
* Electronics.
* Advanced propulsion.
* Scientific manufacturing.

Resource gameplay should involve:

* Prospecting.
* Extraction.
* Power.
* Heat.
* Refining.
* Storage.
* Transportation.
* Production chains.
* Local environmental tradeoffs.

Avoid dozens of indistinguishable resources that only add spreadsheet work.

### 16.3 Off-World Construction

Allow mature facilities to:

* Assemble spacecraft.
* Manufacture replacement parts.
* Refuel vessels.
* Repair vehicles.
* Launch from low-gravity bodies.
* Construct orbital ships.
* Expand colony modules.

Construction should require local infrastructure, materials, energy, time, and trained personnel.

### 16.4 Automated Routes

After the player successfully performs and records a route, allow it to be converted into an automated logistical service.

The route system must track:

* Vehicle capacity.
* Propellant requirements.
* Departure windows.
* Travel time.
* Reliability.
* Infrastructure.
* Resource demand.
* Route interruptions.

Do not run full rigid-body simulation for every automated shipment.

Represent distant activity analytically. Near the player, optionally show scheduled vehicles arriving or departing when it can be done without significant performance cost.

Allow automation for:

* Surface hauling.
* Orbital refueling.
* Satellite deployment.
* Crew rotation.
* Cargo delivery.
* Resource movement.
* Reusable launch systems.

⸻

## 17. Celestial Environment

Create an original home system with enough variety to support many mission types.

At minimum include:

* One habitable homeworld.
* One nearby moon suitable for early landing.
* One small low-gravity body.
* One arid atmospheric world.
* One hostile high-pressure world.
* One gas giant.
* Several distinctive outer moons.
* One distant icy body.
* Asteroids.
* Comets.
* Rings or ring systems.
* Surface anomalies.
* Dangerous terrain or geological activity.

Give each body a gameplay identity based on:

* Gravity.
* Atmosphere.
* Terrain.
* Weather.
* Temperature.
* Radiation.
* Resources.
* Day length.
* Axial tilt.
* Orbital inclination.
* Surface hazards.
* Scientific mysteries.

Architect the system to support additional star systems later.

After the complete home-system game passes its quality gates, add a late-game nearby star system and interstellar propulsion only if doing so does not weaken the completed core game.

⸻

## 18. Planet and Terrain Rendering

Planet rendering must work seamlessly from interplanetary distance to the surface.

Implement:

* Cube-sphere or equivalent planet geometry.
* Quadtree or clipmap LOD.
* Crack-free terrain transitions.
* Camera-relative meshes.
* Procedural detail.
* Authored macro geography.
* PBR terrain materials.
* Triplanar or appropriate terrain texturing.
* Normal detail.
* Surface scatter.
* Rocks.
* Vegetation where appropriate.
* Footprints.
* Wheel tracks.
* Dust.
* Impact marks.
* Landing-pad flattening or terrain preparation.
* Collision-safe terrain streaming.
* Horizon-scale atmospheric blending.

Use instancing and GPU-driven culling for repeated surface objects.

Do not create millions of independent scene objects.

⸻

## 19. Visual Quality

Aim for contemporary high-end visuals while maintaining scalable quality.

### 19.1 Atmospheres

Implement physically inspired:

* Rayleigh scattering.
* Mie scattering.
* Ozone or absorption layers where appropriate.
* Sunset coloration.
* Aerial perspective.
* Limb glow.
* Ground-to-orbit continuity.
* Eclipse response.
* Multiple atmospheric compositions.

### 19.2 Clouds and Weather

Create:

* True volumetric or hybrid volumetric clouds.
* Cloud self-shadowing.
* Planetary cloud shadows.
* Multiple cloud layers.
* Storm systems.
* Rain or snow where appropriate.
* Lightning.
* Fog.
* Wind fields.
* Turbulence.
* Weather-linked visibility.
* Weather forecasting.
* Seamless transition to orbital cloud representation.

Use temporal reconstruction, adaptive ray marching, lower-resolution buffers, and dynamic quality scaling.

Clouds must not halve the frame rate on the default quality setting.

### 19.3 Oceans

Implement:

* Physically plausible water shading.
* Fresnel reflections.
* Sun glint.
* Waves.
* Foam.
* Shore interaction where practical.
* Underwater lighting.
* Buoyancy.
* Reflections that scale by quality tier.

### 19.4 Lighting

Use a modern lighting pipeline with:

* PBR materials.
* Clustered, tiled, or deferred lighting where appropriate.
* Planetshine.
* Emissive engine lighting.
* Reflection probes.
* Screen-space reflections where supported.
* Cascaded or virtualized shadow techniques suitable for large scales.
* Contact shadows.
* Ambient occlusion.
* Eclipse shadows.
* Adapted exposure.
* High dynamic range internal rendering.
* Good tone mapping.

### 19.5 Engines and Atmospheric Effects

Implement:

* Mesh-driven or volumetric engine plumes.
* Pressure-dependent exhaust expansion.
* Shock diamonds where appropriate.
* Engine light.
* Smoke in atmosphere.
* Ballistic exhaust behavior in vacuum.
* RCS plumes.
* Condensation.
* Contrails.
* Mach effects.
* Reentry plasma.
* Ablation debris.
* Dust interaction during landing.
* Physically informed sound changes with atmospheric pressure.

### 19.6 Vehicle Art

Create a coherent, original industrial design language.

Parts must have:

* Consistent texel density.
* Consistent scale.
* PBR materials.
* Functional visual details.
* LODs.
* Damage states where practical.
* Paint and material variants.
* Readable silhouettes.
* Interior views for major crew modules.

Avoid a mixture of mismatched placeholder art styles.

### 19.7 Post-Processing and Camera

Provide restrained, configurable:

* Tone mapping.
* Anti-aliasing.
* Temporal upscaling.
* Bloom.
* Motion blur.
* Depth of field.
* Color grading.
* Film grain.
* Chromatic effects only where justified.
* Camera shake.
* Lens dirt as an optional cinematic feature.

Include:

* Photo mode.
* Free camera.
* Tracking camera.
* Docking camera.
* Interior camera.
* Replay camera.
* Focal-length controls.
* Exposure controls.
* Time-of-day controls in photo mode.

Do not use excessive bloom or post-processing to disguise poor materials or lighting.

⸻

## 20. Audio

Create an original adaptive audio system.

Include:

* Pressure-dependent external engine sound.
* Structural vibration and muffled transmission inside crewed vehicles.
* Near-silence in vacuum except sounds transmitted through the craft.
* RCS.
* Aerodynamic buffeting.
* Sonic effects.
* Reentry.
* Rain and weather.
* Landing gear.
* Wheels.
* Robotics.
* Alarms.
* Communications chatter.
* Crew reactions.
* Environmental ambience.
* Music that changes between construction, launch, orbit, discovery, danger, and success.

Audio must remain informative and not become constant noise.

⸻

## 21. User Experience and Accessibility

The interface must be designed for a complex simulation without becoming cluttered.

Provide:

* Scalable UI.
* Remappable controls.
* Keyboard navigation.
* Gamepad support.
* Colorblind-safe palettes.
* High-contrast mode.
* Subtitles.
* Adjustable text size.
* Reduced motion.
* Separate audio channels.
* Tooltips.
* Unit preferences.
* Scientific and simplified terminology options.
* Pause at any time.
* Searchable in-game reference material.

Create layered complexity:

* Beginner view.
* Standard view.
* Advanced engineering view.

Do not hide essential information from beginners. Present it progressively.

### Tutorials

Create interactive tutorials for:

* Building a basic rocket.
* Staging.
* Stability.
* Reaching space.
* Establishing orbit.
* Maneuver nodes.
* Landing.
* Returning safely.
* Rendezvous.
* Docking.
* Aircraft.
* Rovers.
* Communications.
* Science.
* Resource extraction.
* Colonies.
* Automation.

Tutorials must operate through the real simulation rather than a separate fake version of the game.

⸻

## 22. Save System

Use local-first persistence.

Implement:

* Multiple campaigns.
* Autosaves.
* Quicksaves.
* Named saves.
* Crash recovery.
* Editor recovery.
* Versioned save schema.
* Save migration.
* Local file export.
* Local file import.
* Craft export.
* Mission export.
* Script export.
* Corruption detection.
* Transactional writes.
* Backup rotation.

A failed save migration must never silently destroy the player's campaign.

No account should be required.

⸻

## 23. Modding and User Content

Design content systems to be data-driven from the start.

Support documented definitions for:

* Parts.
* Resources.
* Engines.
* Experiments.
* Missions.
* Contracts.
* Technology.
* Celestial bodies.
* Visual configurations.
* Difficulty profiles.
* Automation libraries.

Use a documented, versioned format such as JSON, JSON5, or YAML.

Provide:

* Schema validation.
* Clear error messages.
* Sample content.
* Import and export.
* Compatibility versioning.
* Safe loading boundaries.
* A mission editor integrated with ordinary campaigns and sandbox play.

Do not expose unrestricted browser execution to untrusted user packages.

⸻

## 24. Performance Requirements

Performance is a release requirement.

### 24.1 Target Hardware Classes

Define and document three device tiers through actual profiling.

At minimum, aim for:

**Baseline Desktop**

A roughly 2020-era four-to-six-core desktop or laptop CPU, 16 GB RAM, and an entry-level discrete GPU or capable integrated GPU.

Target:

* 1080p.
* Medium settings.
* 60 FPS during ordinary flight with a 100–150-part vessel.
* No sustained simulation slowdown.
* Stable frame pacing.

**Recommended Desktop**

A modern midrange CPU and GPU.

Target:

* 1440p.
* High settings.
* 60 FPS during ordinary missions.
* High-quality clouds and terrain.
* 200–300-part vessels without severe slowdown.

**Large-Vessel Stress Mode**

Target:

* A 500-part constructed vehicle remains controllable.
* No catastrophic joint instability.
* No multi-second freezes.
* At least 30 FPS or a clearly reported simulation-limited state on recommended hardware.

Adjust exact targets based on measured browser and hardware results, but never remove performance gates merely because they are difficult.

### 24.2 Frame Budgets

At 60 FPS:

* Total average frame time must remain below 16.7 ms in the standard benchmark.
* Track median, p95, p99, and worst-frame time.
* Avoid long main-thread tasks.
* Avoid garbage-collection spikes.
* Simulation must not allocate heavily in hot loops.
* Input latency must remain low.
* Expensive analysis should run asynchronously.
* Shader compilation should be prewarmed or hidden behind appropriate loading.
* Terrain and texture streaming must be incremental.

### 24.3 Optimization Requirements

Use and verify:

* Object pools.
* Structure-of-arrays layouts where beneficial.
* Typed arrays.
* Cached calculations.
* Instancing.
* Batching.
* Frustum culling.
* Occlusion or hierarchical culling.
* LODs.
* Texture streaming.
* Compressed textures.
* Mesh compression.
* Asset streaming.
* Background workers.
* Dynamic resolution.
* Adaptive cloud quality.
* Temporal upscaling.
* Shadow quality tiers.
* Reduced update frequency for distant systems.
* Analytic background simulation.
* Compound vessel collision shapes.
* Structural clustering.
* No full physics for inactive colonies and supply routes.

### 24.4 Loading and Memory

Aim for:

* A small boot package.
* Progressive first play.
* On-demand high-resolution assets.
* Visible loading progress.
* No downloading the entire universe before the menu appears.
* Warm-cache startup within a few seconds on recommended hardware.
* First-play load appropriate for a browser game rather than a multi-gigabyte monolithic download.
* Stable memory use during a 30-minute session.
* No continuously rising memory footprint.
* Explicit GPU-resource disposal.

Create an in-game performance overlay showing:

* FPS.
* Frame time.
* Simulation time.
* Render time.
* Draw calls.
* Triangle count.
* Active rigid bodies.
* Active vessel parts.
* Worker utilization.
* CPU memory.
* Estimated GPU memory where available.
* Loaded terrain tiles.
* Network and asset-streaming status.

⸻

## 25. Quality Tiers

Provide at least:

* Low.
* Medium.
* High.
* Ultra.
* Custom.

Allow independent control over:

* Render scale.
* Anti-aliasing.
* Upscaling.
* Terrain detail.
* Surface-object density.
* Cloud quality.
* Cloud shadows.
* Water quality.
* Reflections.
* Ambient occlusion.
* Shadow distance.
* Shadow resolution.
* Particle density.
* Lighting quality.
* Texture quality.
* Interior detail.
* Post-processing.

Include an automatic benchmark that recommends settings.

Changing settings must not require reloading the entire game unless technically unavoidable.

⸻

## 26. Development Milestones

Every milestone must end in a playable build.

### Milestone 0: Risk Prototypes

Benchmark and validate:

* Planet-scale coordinates.
* Active-to-analytic vessel transitions.
* A 150-part structural graph.
* Rendering a planetary surface from orbit to ground.
* Terrain streaming.
* Aerodynamic preprocessing.
* Volumetric clouds.
* WebGPU and fallback behavior.
* Worker communication.
* Save serialization.

Record results in ARCHITECTURE.md and PERFORMANCE.md.

### Milestone 1: Complete Vertical Slice

Deliver:

* One original planet.
* One moon.
* Construction editor.
* At least 35 functional parts.
* Staging.
* Aerodynamics.
* Launch.
* Stable orbit.
* Maneuver node.
* Time warp.
* Moon transfer.
* Landing.
* Return.
* Basic science.
* Save and load.
* Medium-quality atmosphere, terrain, clouds, water, and plumes.
* Interactive tutorial.
* Performance overlay.

This must be a real playable game loop.

### Milestone 2: Full Home-System Sandbox

Add:

* Complete home system.
* Aircraft.
* Rovers.
* Docking.
* Stations.
* EVA.
* Communications.
* Mapping.
* Resource extraction.
* More science.
* Robotics.
* Advanced editor tools.
* Transfer planner.
* Alarm system.
* Trajectory prediction.
* Multiple missions.
* Expanded part library.
* High-quality visual pipeline.

### Milestone 3: Progression and Space Program

Add:

* Exploration mode.
* Space Program mode.
* Technology.
* Funding.
* Facilities.
* Crew careers.
* Contracts and authored mission arcs.
* Mission editor.
* Reliability options.
* Life-support options.
* Automation progression.
* Full tutorial path.

### Milestone 4: Colonies and Logistics

Add:

* Surface colonies.
* Orbital shipyards.
* Resource chains.
* Off-world construction.
* Automated proven routes.
* Colony science.
* Colony growth.
* Large-vessel construction.
* Late-game propulsion.
* Long-duration mission systems.

### Milestone 5: Final Polish and Expansion

After all previous milestones satisfy their gates:

* Improve visual consistency.
* Complete production-quality original assets.
* Improve audio.
* Add discoveries and authored content.
* Add advanced orbital options.
* Add a second star system only if the core game remains performant and complete.
* Conduct extensive browser compatibility, accessibility, save migration, and soak testing.

Do not skip directly to colonies or interstellar travel while the fundamental editor, flight, orbital, save, or performance systems remain unreliable.

⸻

## 27. Testing Requirements

### 27.1 Unit Tests

Test:

* Orbital propagation.
* Reference-frame conversion.
* Maneuver calculations.
* Delta-v.
* Staging.
* Resource flow.
* Power.
* Thermal balance.
* Communications.
* Science processing.
* Save serialization.
* Script sandbox.
* Structural analysis.
* Aerodynamic preprocessing.

### 27.2 Property and Fuzz Tests

Test invariants such as:

* No NaN or infinite vessel state.
* Mass cannot become negative.
* Resources remain conserved except through defined sources and sinks.
* Save/load round trips preserve state.
* Stable analytic orbits remain stable within tolerance.
* Stage graphs remain valid after arbitrary editor operations.
* Random craft construction cannot crash the editor.
* Invalid user content fails safely.

### 27.3 End-to-End Browser Tests

Automate:

* Start campaign.
* Complete tutorial.
* Construct vehicle.
* Save craft.
* Launch.
* Stage.
* Reach orbit.
* Create maneuver.
* Time warp.
* Land.
* Recover.
* Save campaign.
* Reload campaign.
* Resume flight.
* Change graphics settings.
* Import and export craft.
* Handle WebGPU failure and fallback.

### 27.4 Visual Tests

Use visual regression tests for:

* Editor.
* HUD.
* Map view.
* Atmosphere.
* Cloud transitions.
* Terrain LOD.
* Engine plumes.
* Shadows.
* Eclipses.
* Water.
* UI scaling.
* Colorblind modes.

### 27.5 Performance Tests

Create reproducible benchmarks for:

* 50-part rocket.
* 150-part rocket.
* 300-part station.
* 500-part stress vehicle.
* Dense colony.
* Atmospheric launch.
* High-altitude cloud flight.
* Orbital map with many missions.
* Terrain traversal at rover speed.
* High-speed aircraft.
* Reentry.
* Docking between two large ships.
* Thirty-minute soak.
* Repeated editor-to-flight transitions.
* Repeated save and load.

Store benchmark history and fail CI when meaningful regressions occur.

⸻

## 28. Mandatory Gameplay Acceptance Scenarios

The project cannot be described as complete until a player can perform all of these in the actual game:

1. Build a multi-stage rocket while viewing accurate stage delta-v and thrust-to-weight estimates.
2. Launch it through a simulated atmosphere.
3. Reach a stable orbit manually.
4. Plan and execute an orbital maneuver.
5. Travel to a moon.
6. Land.
7. Collect meaningful science.
8. Return safely.
9. Build and fly an aircraft using lift, drag, stalls, and landing gear.
10. Build and drive a rover over streamed terrain.
11. Launch a communications relay and use it to control a probe.
12. Rendezvous and dock two independently launched craft.
13. Build a station and transfer crew and resources.
14. Run a long-duration experiment in the background.
15. Prospect for and extract a resource.
16. Refine that resource into something useful.
17. Establish an off-world outpost.
18. Construct or refuel a vehicle away from the homeworld.
19. Prove a logistics route manually and automate its later repetitions.
20. Write or assemble a small flight-control program.
21. Save, close, reload, and continue without state corruption.
22. Complete these scenarios with stable, measured performance.

⸻

## 29. Completion and Self-Critique Protocol

Do not stop after the first successful build.

Before calling any milestone complete:

1. Run all tests.
2. Run all benchmark scenes.
3. Play the milestone's primary loop from beginning to end.
4. Inspect browser console output.
5. Inspect memory use.
6. Inspect frame pacing.
7. Test save and reload.
8. Test graphics-quality transitions.
9. Test the fallback renderer.
10. Test failure cases.
11. List the ten most serious remaining shortcomings.
12. Fix every release-blocking problem and as many major shortcomings as possible.
13. Repeat this audit at least three times for the final release candidate.

A release-blocking problem includes:

* Crashes.
* Save corruption.
* Broken primary controls.
* Incorrect staging.
* Frequent NaN physics.
* Spontaneous vessel destruction.
* Severe frame-rate collapse in target scenarios.
* Unusable editor interactions.
* Major browser incompatibility without a clear fallback.
* Placeholder core gameplay.
* Missing required acceptance scenarios.
* Misleading or fake telemetry.
* Copyright or license violations.

Do not use subjective satisfaction as the only completion test. Operationalize "excellent work" through passing functionality, visual, performance, stability, accessibility, and documentation gates.

When an external limitation prevents completion, state exactly:

* What is working.
* What is incomplete.
* What failed.
* What evidence was collected.
* The next concrete engineering action.

Never falsely claim the entire game is finished.

⸻

## 30. Required Repository Deliverables

Maintain:

* README.md
* ARCHITECTURE.md
* FEATURES.md
* PHYSICS.md
* RENDERING.md
* PERFORMANCE.md
* CONTENT_PIPELINE.md
* MODDING.md
* ACCESSIBILITY.md
* QA.md
* LICENSES.md
* ATTRIBUTIONS.md
* CHANGELOG.md

FEATURES.md must contain a traceability matrix with:

* Feature.
* Player value.
* Inspiration category.
* Original implementation.
* Current status.
* Tests.
* Performance impact.
* Difficulty setting.
* Known limitations.

Provide commands for:

* Development.
* Production build.
* Unit tests.
* End-to-end tests.
* Linting.
* Type checking.
* Performance benchmarks.
* Asset validation.
* Local static hosting.

The production build must be deployable to ordinary HTTPS static hosting unless a clearly documented optional service requires otherwise.

⸻

## 31. Final Standard

The finished game must not merely demonstrate that rockets can be drawn in a browser.

It must demonstrate that a browser can host a deep, stable, visually impressive orbital-engineering game with:

* A satisfying construction editor.
* Credible aerospace behavior.
* Accurate and understandable orbital mechanics.
* Exploration worth performing.
* Integrated engineering tools.
* Meaningful scientific progression.
* Optional realism.
* Powerful but responsible automation.
* Large-scale colonies and logistics.
* Original art and identity.
* Excellent frame pacing.
* Scalable graphics.
* Reliable saves.
* Strong documentation.
* A complete, repeatable gameplay loop.

Build the game that experienced orbital-sandbox players wish had been designed around modern hardware, modern browsers, modern graphics, and more than a decade of community lessons.

Begin by inspecting the environment, creating the risk prototypes, measuring them, selecting the architecture, and then implementing the Milestone 1 vertical slice. Do not remain in the planning stage.
