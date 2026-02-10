{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkIf
    mkMerge
    types
    ;

  inherit (pkgs.callPackage ../lib/shared.nix { inherit lib; })
    mergeAttrsList
    applyPostPatch
    mkPluginKit
    ;

  dop = with types; coercedTo package (a: a.outPath) pathInStore;

in
{
  options.programs.nixcord = import ../options.nix {
    inherit
      lib
      pkgs
      dop
      applyPostPatch
      ;
  };

  config = mkIf config.programs.nixcord.enable (
    let
      cfg = config.programs.nixcord;

      parseRules = cfg.parseRules;

      inherit (pkgs.callPackage ../lib/core.nix { inherit lib parseRules; })
        mkVencordCfg
        mkFinalPackages
        ;

      pluginKit = mkPluginKit { inherit cfg; };

      inherit (pluginKit)
        pluginNameMigrations
        collectDeprecatedPlugins
        mkFullConfig
        ;

      vencordFullConfig = mkFullConfig {
        baseConfig = cfg.config;
        extraConfig = cfg.extraConfig;
        clientConfig = cfg.vencordConfig;
      };

      equicordFullConfig = mkFullConfig {
        baseConfig = cfg.config;
        extraConfig = cfg.extraConfig;
        clientConfig = cfg.equicordConfig;
      };

      vesktopFullConfig = mergeAttrsList [
        cfg.config
        cfg.extraConfig
        cfg.vesktopConfig
      ];

      equibopFullConfig = mergeAttrsList [
        cfg.config
        cfg.extraConfig
        cfg.equibopConfig
      ];

      quickCssFile = pkgs.writeText "nixcord-quickcss.css" cfg.quickCss;

      vencordSettingsFile = pkgs.writeText "nixcord-settings.json" (
        builtins.toJSON (mkVencordCfg vencordFullConfig)
      );
      equicordSettingsFile = pkgs.writeText "nixcord-equicord-settings.json" (
        builtins.toJSON (mkVencordCfg equicordFullConfig)
      );

      discordSettingsFile =
        if cfg.discord.settings != { } then
          pkgs.writeText "nixcord-discord-settings.json" (builtins.toJSON (mkVencordCfg cfg.discord.settings))
        else
          null;

      vesktopSettingsFile = pkgs.writeText "nixcord-vesktop-settings.json" (
        builtins.toJSON (mkVencordCfg vesktopFullConfig)
      );
      vesktopClientSettingsFile =
        if cfg.vesktop.settings != { } then
          pkgs.writeText "nixcord-vesktop-client-settings.json" (
            builtins.toJSON (mkVencordCfg cfg.vesktop.settings)
          )
        else
          null;

      vesktopStateFile =
        if cfg.vesktop.state != { } then
          pkgs.writeText "nixcord-vesktop-state.json" (builtins.toJSON (mkVencordCfg cfg.vesktop.state))
        else
          null;

      equibopSettingsFile = pkgs.writeText "nixcord-equibop-settings.json" (
        builtins.toJSON (mkVencordCfg equibopFullConfig)
      );
      equibopClientSettingsFile =
        if cfg.equibop.settings != { } then
          pkgs.writeText "nixcord-equibop-client-settings.json" (
            builtins.toJSON (mkVencordCfg cfg.equibop.settings)
          )
        else
          null;

      equibopStateFile =
        if cfg.equibop.state != { } then
          pkgs.writeText "nixcord-equibop-state.json" (builtins.toJSON (mkVencordCfg cfg.equibop.state))
        else
          null;

      mkThemeFile =
        name: value:
        if builtins.isPath value || lib.isStorePath value then
          value
        else
          pkgs.writeText "nixcord-theme-${name}.css" value;

      vesktopThemes = lib.mapAttrs mkThemeFile cfg.config.themes;

      dorionConfigFile =
        if cfg.dorion.enable then
          let
            toSnakeCase =
              str:
              lib.pipe str [
                (builtins.split "([A-Z])")
                (builtins.foldl' (
                  acc: part:
                  if builtins.isList part then acc + "_" + (lib.toLower (builtins.elemAt part 0)) else acc + part
                ) "")
                (builtins.replaceStrings [ "__" ] [ "_" ])
              ];
            dorionConfig = {
              autoupdate = false;
            }
            // (lib.mapAttrs' (name: value: {
              name = toSnakeCase name;
              inherit value;
            }) (builtins.removeAttrs cfg.dorion [ "extraSettings" ]));
          in
          pkgs.writeText "nixcord-dorion-config.json" (
            builtins.toJSON (dorionConfig // cfg.dorion.extraSettings)
          )
        else
          null;

      homeDir = "/Users/${cfg.user}";

      activationScripts = import ../lib/activation.nix {
        inherit
          lib
          pkgs
          cfg
          mkVencordCfg
          ;
        wrapScript = script: ''
          ${script}
        '';
      };

    in
    mkMerge ([
      {
        programs.nixcord = {
          discord.configDir = lib.mkDefault (
            let
              basePath = "${homeDir}/Library/Application Support";
              branchDirName =
                {
                  stable = "discord";
                  ptb = "discordptb";
                  canary = "discordcanary";
                  development = "discorddevelopment";
                }
                .${cfg.discord.branch} or "discord";
            in
            "${basePath}/${branchDirName}"
          );
          configDir = lib.mkDefault (
            let
              basePath = "${homeDir}/Library/Application Support";
              dirName = if cfg.discord.equicord.enable then "Equicord" else "Vencord";
            in
            "${basePath}/${dirName}"
          );
          vesktop.configDir = lib.mkDefault "${homeDir}/Library/Application Support/vesktop";
          equibop.configDir = lib.mkDefault "${homeDir}/Library/Application Support/equibop";
          dorion.configDir = lib.mkDefault "${homeDir}/.config/dorion";
        };
      }
      {
        programs.nixcord.finalPackage = mkFinalPackages {
          inherit cfg;
          vencord = applyPostPatch {
            inherit cfg;
            pkg = cfg.discord.vencord.package;
          };
          equicord = applyPostPatch {
            inherit cfg;
            pkg = cfg.discord.equicord.package;
          };
        };

        environment.systemPackages = mkMerge [
          (mkIf (cfg.discord.enable && cfg.discord.installPackage) [ cfg.finalPackage.discord ])
          (mkIf (cfg.vesktop.enable && cfg.vesktop.installPackage) [ cfg.finalPackage.vesktop ])
          (mkIf (cfg.equibop.enable && cfg.finalPackage.equibop != null && cfg.equibop.installPackage) [
            cfg.finalPackage.equibop
          ])
          (mkIf (cfg.dorion.enable && cfg.dorion.installPackage) [ cfg.finalPackage.dorion ])
        ];
      }
      (mkIf cfg.enable {
        system.activationScripts.applications.text = lib.mkAfter (
          let
            install = lib.getExe' pkgs.coreutils "install";
            mkDir = dir: "${install} -d -o ${lib.escapeShellArg cfg.user} -g staff ${lib.escapeShellArg dir}";
            mkCopy = src: dest: "copy_file ${src} ${lib.escapeShellArg dest} 0644";
            useQuickCss =
              clientCfg: cfg.quickCss != "" && (cfg.config.useQuickCss || clientCfg.useQuickCss or false);
          in
          ''
            ${mkDir cfg.configDir}
            ${lib.optionalString cfg.discord.enable (mkDir cfg.discord.configDir)}
            ${lib.optionalString cfg.vesktop.enable (mkDir cfg.vesktop.configDir)}
            ${lib.optionalString cfg.equibop.enable (mkDir cfg.equibop.configDir)}
            ${lib.optionalString cfg.dorion.enable (mkDir cfg.dorion.configDir)}

            copy_file() {
              sudo --user=${lib.escapeShellArg cfg.user} -- ${install} -D -m "$3" "$1" "$2"
            }

            ${lib.optionalString cfg.discord.enable ''
              # Disable Discord updates
              config_dir="${cfg.discord.configDir}"
              if [ -f "$config_dir/settings.json" ]; then
                ${lib.getExe' pkgs.jq "jq"} '. + {"SKIP_HOST_UPDATE": true}' "$config_dir/settings.json" > "$config_dir/settings.json.tmp" && mv "$config_dir/settings.json.tmp" "$config_dir/settings.json"
              else
                echo '{"SKIP_HOST_UPDATE": true}' > "$config_dir/settings.json"
              fi

              config_base="/Users/${cfg.user}/Library/Application Support"

              get_discord_versions() {
                local branch_dir="$1"
                find "$branch_dir" -maxdepth 1 -type d -name '[0-9]*.[0-9]*.[0-9]*' | sed "s|^$branch_dir/||" | sort -V
              }

              modules_need_copy() {
                local modules_dir="$1"
                if [ ! -d "$modules_dir" ]; then
                  return 0
                fi
                local item_count
                item_count=$(find "$modules_dir" -mindepth 1 -maxdepth 1 ! -name 'pending' | wc -l)
                [ "$item_count" -eq 0 ]
              }

              for branch in discord discord-ptb discord-canary discord-development; do
                branch_dir="$config_base/$branch"

                [ ! -d "$branch_dir" ] && continue

                # Get sorted list of version directories
                versions=$(get_discord_versions "$branch_dir")
                version_count=$(echo "$versions" | wc -l)

                if [ "$version_count" -ge 2 ]; then
                  prev_version=$(echo "$versions" | sed -n "$((version_count-1))p")
                  curr_version=$(echo "$versions" | tail -n 1)

                  prev_modules="$branch_dir/$prev_version/modules"
                  curr_modules="$branch_dir/$curr_version/modules"

                  if modules_need_copy "$curr_modules" && [ -d "$prev_modules" ]; then
                    echo "Copying Discord modules for $branch from $prev_version to $curr_version"
                    rm -rf "$curr_modules"
                    cp -a "$prev_modules" "$curr_modules"
                  fi
                fi
              done

              ${lib.optionalString cfg.discord.vencord.enable (
                mkCopy vencordSettingsFile "${cfg.configDir}/settings/settings.json"
              )}
              ${lib.optionalString cfg.discord.equicord.enable (
                mkCopy equicordSettingsFile "${cfg.configDir}/settings/settings.json"
              )}
              ${lib.optionalString (cfg.discord.settings != { }) (
                mkCopy discordSettingsFile "${cfg.discord.configDir}/settings.json"
              )}
              ${lib.optionalString (useQuickCss cfg.vencordConfig || useQuickCss cfg.equicordConfig) (
                mkCopy quickCssFile "${cfg.configDir}/settings/quickCss.css"
              )}
            ''}

            # Vesktop files
            ${lib.optionalString cfg.vesktop.enable ''
              ${mkCopy vesktopSettingsFile "${cfg.vesktop.configDir}/settings/settings.json"}
              ${mkCopy vesktopClientSettingsFile "${cfg.vesktop.configDir}/settings.json"}
              ${lib.optionalString (cfg.vesktop.settings != { }) (
                mkCopy vesktopClientSettingsFile "${cfg.vesktop.configDir}/settings.json"
              )}
              ${lib.optionalString (cfg.vesktop.state != { }) (
                mkCopy vesktopStateFile "${cfg.vesktop.configDir}/state.json"
              )}
              ${lib.optionalString (useQuickCss cfg.vesktopConfig) (
                mkCopy quickCssFile "${cfg.vesktop.configDir}/settings/quickCss.css"
              )}
              ${lib.concatStringsSep "\n" (
                lib.mapAttrsToList (
                  name: path: mkCopy path "${cfg.vesktop.configDir}/themes/${name}.css"
                ) vesktopThemes
              )}
            ''}

            # Equibop files
            ${lib.optionalString cfg.equibop.enable ''
              ${mkCopy equibopSettingsFile "${cfg.equibop.configDir}/settings/settings.json"}
              ${mkCopy equibopClientSettingsFile "${cfg.equibop.configDir}/settings.json"}
              ${lib.optionalString (cfg.equibop.settings != { }) (
                mkCopy equibopClientSettingsFile "${cfg.equibop.configDir}/settings.json"
              )}
              ${lib.optionalString (cfg.equibop.state != { }) (
                mkCopy equibopStateFile "${cfg.equibop.configDir}/state.json"
              )}
              ${lib.optionalString (useQuickCss cfg.equibopConfig) (
                mkCopy quickCssFile "${cfg.equibop.configDir}/settings/quickCss.css"
              )}
            ''}

            # Dorion files
            ${lib.optionalString cfg.dorion.enable (
              mkCopy dorionConfigFile "${cfg.dorion.configDir}/config.json"
            )}
          ''
        );
      })
      (mkIf cfg.dorion.enable {
        system.activationScripts.nixcord-setupDorionVencordSettings.text =
          activationScripts.setupDorionVencordSettings;
      })
      {
        warnings = import ../../warnings.nix {
          inherit
            cfg
            mkIf
            lib
            pluginNameMigrations
            ;
          deprecatedPlugins = collectDeprecatedPlugins cfg.config;
        };

        assertions = [
          {
            assertion = !(cfg.discord.vencord.enable && cfg.discord.equicord.enable);
            message = "programs.nixcord.discord.vencord.enable and programs.nixcord.discord.equicord.enable cannot both be enabled at the same time. They are mutually exclusive.";
          }
        ];
      }
    ])
  );
}
