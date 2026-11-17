use std::path::Path;

/// Pd core sources, mirroring `PD_FILES` in vendor/libpd/Makefile.
/// The optional "extra" externals (bob~, sigmund~, ...) are left out on purpose:
/// they may be missing on the Organelle, so the preview should not have them either.
const PD_SOURCES: &[&str] = &[
    "d_arithmetic.c", "d_array.c", "d_ctl.c", "d_dac.c", "d_delay.c", "d_fft.c",
    "d_fft_fftsg.c", "d_filter.c", "d_global.c", "d_math.c", "d_misc.c", "d_osc.c",
    "d_resample.c", "d_soundfile.c", "d_soundfile_aiff.c", "d_soundfile_caf.c",
    "d_soundfile_next.c", "d_soundfile_wave.c", "d_ugen.c", "g_all_guis.c", "g_array.c",
    "g_bang.c", "g_canvas.c", "g_clone.c", "g_editor.c", "g_editor_extras.c", "g_graph.c",
    "g_guiconnect.c", "g_io.c", "g_mycanvas.c", "g_numbox.c", "g_radio.c", "g_readwrite.c",
    "g_rtext.c", "g_scalar.c", "g_slider.c", "g_template.c", "g_text.c", "g_toggle.c",
    "g_traversal.c", "g_undo.c", "g_vumeter.c", "m_atom.c", "m_binbuf.c", "m_class.c",
    "m_conf.c", "m_glob.c", "m_memory.c", "m_obj.c", "m_pd.c", "m_sched.c", "s_audio.c",
    "s_audio_dummy.c", "s_inter.c", "s_inter_gui.c", "s_loader.c", "s_main.c", "s_net.c",
    "s_path.c", "s_print.c", "s_utf8.c", "x_acoustics.c", "x_arithmetic.c", "x_array.c",
    "x_connective.c", "x_file.c", "x_gui.c", "x_interface.c", "x_list.c", "x_midi.c",
    "x_misc.c", "x_net.c", "x_scalar.c", "x_text.c", "x_time.c", "x_vexp.c", "x_vexp_if.c",
    "x_vexp_fun.c",
];

const WRAPPER_SOURCES: &[&str] = &[
    "s_libpdmidi.c",
    "x_libpdreceive.c",
    "z_hooks.c",
    "z_libpd.c",
    "util/z_print_util.c",
];

fn build_libpd() {
    let libpd = Path::new("vendor/libpd");
    let pd_src = libpd.join("pure-data/src");
    let wrapper = libpd.join("libpd_wrapper");
    assert!(
        pd_src.join("m_pd.h").exists(),
        "vendor/libpd is missing; run `git submodule update --init --recursive`"
    );

    let mut build = cc::Build::new();
    build
        .warnings(false)
        .include(&wrapper)
        .include(wrapper.join("util"))
        .include(&pd_src)
        .define("PD", None)
        .define("USEAPI_DUMMY", None)
        .define("PD_INTERNAL", None)
        .define("HAVE_UNISTD_H", None)
        // Pd is single precision on the Organelle; keep the preview the same.
        .define("PD_FLOATSIZE", "32")
        .flag_if_supported("-fno-strict-aliasing");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" => {
            build
                .define("HAVE_ALLOCA_H", None)
                .define("HAVE_MACHINE_ENDIAN_H", None)
                .define("_DARWIN_C_SOURCE", None)
                .define("HAVE_LIBDL", None);
        }
        "linux" => {
            build
                .define("HAVE_ALLOCA_H", None)
                .define("HAVE_ENDIAN_H", None)
                .define("HAVE_LIBDL", None);
            println!("cargo:rustc-link-lib=dl");
            println!("cargo:rustc-link-lib=m");
        }
        "windows" => {
            build.define("WINVER", "0x502").define("WIN32", None).define("_WIN32", None);
            println!("cargo:rustc-link-lib=ws2_32");
        }
        _ => {}
    }

    for file in PD_SOURCES {
        build.file(pd_src.join(file));
    }
    for file in WRAPPER_SOURCES {
        build.file(wrapper.join(file));
    }
    build.compile("pd");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=vendor/libpd/libpd_wrapper");
}

fn main() {
    build_libpd();
    tauri_build::build()
}
